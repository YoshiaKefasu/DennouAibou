// Package audio holds the 電脳架電 (Dennou Kaden) low-latency audio building
// blocks.
//
// personal_filter.go implements a dependency-free personal speaker filter in
// the spirit of Krisp-style "only the enrolled microphone owner is sent" gating.
// It uses the Go standard library only (no CGO, no DSP packages) and runs three
// stages per 16 ms frame:
//
//  1. VAD: RMS against an exponential-moving noise floor, plus a zero-crossing
//     rate sanity check.
//  2. Pitch: normalized autocorrelation over a 512-sample mirror ring buffer,
//     yielding F0 (Hz) and a periodicity score in 0..1.
//  3. Speaker tracking: an enrolled profile (mean F0, F0 spread, reference
//     level) with a sigma band, a volume distance gate and hysteresis.
//
// Every buffer is allocated once by NewFilter, so Process performs zero heap
// allocations and is safe to call from a real-time audio path.
package audio

import (
	"fmt"
	"math"
)

// Analysis constants. The internal rate is fixed: 48 kHz input is decimated
// 3:1 with a boxcar average, which is enough for the 80-350 Hz pitch band this
// filter cares about.
const (
	analysisRate     = 16000
	analysisFrameMS  = 16
	ringSize         = 512 // autocorrelation window (two 16 ms frames)
	pitchSearchMaxHz = 600.0
)

// Reason strings reported by Verdict.Reason.
const (
	// ReasonSilence means the VAD stage rejected the frame (too quiet, or
	// zero-crossing rate too high to be speech).
	ReasonSilence = "silence"
	// ReasonUnvoiced means the frame is loud enough but has no stable pitch.
	ReasonUnvoiced = "unvoiced"
	// ReasonPitchOutOfBand means the measured F0 fell outside the absolute
	// band or outside the enrolled profile's sigma band.
	ReasonPitchOutOfBand = "pitch_out_of_band"
	// ReasonTooFar means the frame was quieter than the enrolled reference
	// level gate (i.e. the talker is not at the enrolled distance).
	ReasonTooFar = "too_far"
	// ReasonUser means the frame matched the enrolled speaker.
	ReasonUser = "user"
	// ReasonEnrolling means the profile is still being built. Enrollment is
	// fail-closed: IsUser stays false until the profile is complete.
	ReasonEnrolling = "enrolling"
)

// VAD tuning.
const (
	vadAbsMin       = 0.0035 // absolute RMS floor (-49 dBFS)
	vadFactor       = 3.0    // signal must be this much above the noise floor
	zcrNoiseMax     = 0.55   // white noise sits around 0.5; speech is far lower
	noiseFloorInit  = 0.003
	noiseFloorMin   = 1e-6
	noiseFloorAlpha = 0.12
)

// Speaker-tracking tuning.
const (
	minSigmaHz        = 8.0  // F0 spread floor, so a perfectly steady enrollment still has a band
	sigmaRelativeMin  = 0.03 // ...and a relative floor (3% of the mean F0)
	volumeGateRatio   = 0.12 // reference level gate: -18 dB below enrollment
	enterThreshold    = 0.60 // hysteresis: score needed to become the user
	exitThreshold     = 0.45 // hysteresis: score below which the user is dropped
	pitchWeight       = 0.65
	levelWeight       = 0.35
	profileAlphaPitch = 0.02
	profileAlphaLevel = 0.05
	energyEpsilon     = 1e-12
	// enrollSettleFactor stretches the enrollment window to EnrollFrames ×
	// this factor. Once the candidate array is full the filter keeps replacing
	// its quietest entry with louder frames until the window closes, so the
	// frozen profile is biased towards the talker's loudest (closest) speech.
	enrollSettleFactor = 3
)

// Config tunes the personal speaker filter. Pass DefaultConfig and override
// only what you need; normalize() fills in any zero field with its default.
type Config struct {
	// SampleRate is the input rate in Hz. Supported: 16000 and 48000
	// (48 kHz is decimated 3:1 to 16 kHz internally).
	SampleRate int
	// Channels is the interleaved channel count of the input PCM. Stereo is
	// downmixed with (L+R)/2.
	Channels int
	// FrameMS is the analysis frame length in milliseconds. 16 ms (256 samples
	// at 16 kHz) is the only supported value.
	FrameMS int
	// MinF0Hz and MaxF0Hz bound the accepted pitch band.
	MinF0Hz float64
	MaxF0Hz float64
	// EnrollFrames is how many voiced frames fill the candidate array. The
	// enrollment window stays open for EnrollFrames × 3 frames (30 × 3 × 16 ms
	// ≈ 1.5 s) so louder candidates can keep replacing quieter ones before the
	// profile freezes.
	EnrollFrames int
	// PitchSigmas is the allowed F0 distance from the enrolled mean, measured
	// in standard deviations.
	PitchSigmas float64
	// VoicingMin is the normalized-autocorrelation floor separating voiced from
	// unvoiced frames.
	VoicingMin float64
}

// DefaultConfig returns the tuned defaults described in DENNOU_KADEN.md §6.
func DefaultConfig() Config {
	return Config{
		SampleRate:   16000,
		Channels:     1,
		FrameMS:      analysisFrameMS,
		MinF0Hz:      80.0,
		MaxF0Hz:      350.0,
		EnrollFrames: 30,
		PitchSigmas:  2.5,
		VoicingMin:   0.35,
	}
}

// normalize fills defaults into zero fields and rejects unsupported values.
func (c Config) normalize() (Config, error) {
	defaults := DefaultConfig()
	if c.SampleRate == 0 {
		c.SampleRate = defaults.SampleRate
	}
	if c.Channels == 0 {
		c.Channels = defaults.Channels
	}
	if c.FrameMS == 0 {
		c.FrameMS = defaults.FrameMS
	}
	if c.MinF0Hz == 0 {
		c.MinF0Hz = defaults.MinF0Hz
	}
	if c.MaxF0Hz == 0 {
		c.MaxF0Hz = defaults.MaxF0Hz
	}
	if c.EnrollFrames == 0 {
		c.EnrollFrames = defaults.EnrollFrames
	}
	if c.PitchSigmas == 0 {
		c.PitchSigmas = defaults.PitchSigmas
	}
	if c.VoicingMin == 0 {
		c.VoicingMin = defaults.VoicingMin
	}

	switch c.SampleRate {
	case 16000, 48000:
	default:
		return Config{}, fmt.Errorf("personal filter: unsupported sample rate %d (want 16000 or 48000)", c.SampleRate)
	}
	if c.Channels != 1 && c.Channels != 2 {
		return Config{}, fmt.Errorf("personal filter: unsupported channel count %d (want 1 or 2)", c.Channels)
	}
	if c.FrameMS != analysisFrameMS {
		return Config{}, fmt.Errorf("personal filter: unsupported frame length %d ms (want %d)", c.FrameMS, analysisFrameMS)
	}
	if !(c.MinF0Hz > 0) || !(c.MaxF0Hz > c.MinF0Hz) {
		return Config{}, fmt.Errorf("personal filter: invalid pitch band %v..%v Hz", c.MinF0Hz, c.MaxF0Hz)
	}
	if c.EnrollFrames < 1 {
		return Config{}, fmt.Errorf("personal filter: enrollFrames must be >= 1, got %d", c.EnrollFrames)
	}
	if c.PitchSigmas <= 0 {
		return Config{}, fmt.Errorf("personal filter: pitchSigmas must be > 0, got %v", c.PitchSigmas)
	}
	if c.VoicingMin <= 0 || c.VoicingMin >= 1 {
		return Config{}, fmt.Errorf("personal filter: voicingMin must be in (0,1), got %v", c.VoicingMin)
	}
	return c, nil
}

// Verdict is the per-frame result of the three-stage pipeline.
type Verdict struct {
	// Voiced is the VAD stage result (loud enough and not noise-like).
	Voiced bool
	// F0Hz is the measured pitch in Hz; 0 when the frame is unvoiced.
	F0Hz float64
	// RMS is the normalized frame energy (0..1 for full-scale PCM).
	RMS float64
	// ZCR is the zero-crossing rate (0..1).
	ZCR float64
	// Periodicity is the normalized autocorrelation peak (0..1).
	Periodicity float64
	// IsUser is the final personal-speaker decision.
	IsUser bool
	// Score is the speaker match score (0..1).
	Score float64
	// Reason explains the decision; one of the Reason* constants.
	Reason string
}

// Filter is a single-speaker personal filter. Create one per audio stream; it
// is not safe for concurrent use.
type Filter struct {
	cfg      Config
	ratio    int // input samples per analysis sample (1 or 3)
	frameLen int // mono analysis samples per frame (256)
	minLag   int
	maxLag   int
	corrLen  int // samples compared per lag in the autocorrelation

	ring    []float64 // 2*ringSize mirror buffer for allocation-free windows
	ringPos int       // next write slot in [0, ringSize)

	acc    []float64 // partial mono frame
	accLen int
	decSum float64 // boxcar decimation accumulator
	decN   int

	corr []float64 // autocorrelation scratch, one slot per lag

	noiseFloor float64

	candF0  []float64 // loudest-first enrollment candidates
	candRMS []float64
	candN   int

	enrollFrames int // voiced in-band frames seen while enrolling

	enrolled bool
	mu       float64 // enrolled mean F0
	sigma    float64 // enrolled F0 spread
	refRMS   float64 // enrolled reference level

	active bool // hysteresis state
}

// NewFilter builds a filter with all buffers preallocated.
func NewFilter(cfg Config) (*Filter, error) {
	normalized, err := cfg.normalize()
	if err != nil {
		return nil, err
	}

	frameLen := analysisRate * normalized.FrameMS / 1000
	if frameLen > ringSize {
		return nil, fmt.Errorf("personal filter: frame of %d samples exceeds the %d sample window", frameLen, ringSize)
	}

	// Search a little above MaxF0Hz so that a too-high pitch is measured (and
	// reported as out of band) instead of folding onto a sub-harmonic.
	searchMaxHz := math.Max(pitchSearchMaxHz, normalized.MaxF0Hz+50)
	minLag := int(math.Round(float64(analysisRate) / searchMaxHz))
	if minLag < 2 {
		minLag = 2
	}
	maxLag := int(math.Floor(float64(analysisRate) / normalized.MinF0Hz))
	if maxLag < 1 || minLag > maxLag {
		return nil, fmt.Errorf("personal filter: F0 range invalid for sample rate")
	}
	if maxLag >= ringSize-1 {
		return nil, fmt.Errorf("personal filter: minF0Hz %v Hz needs %d samples of lag, window is %d", normalized.MinF0Hz, maxLag, ringSize)
	}

	return &Filter{
		cfg:        normalized,
		ratio:      normalized.SampleRate / analysisRate,
		frameLen:   frameLen,
		minLag:     minLag,
		maxLag:     maxLag,
		corrLen:    ringSize - maxLag,
		ring:       make([]float64, 2*ringSize),
		acc:        make([]float64, frameLen),
		corr:       make([]float64, maxLag-minLag+1),
		noiseFloor: noiseFloorInit,
		candF0:     make([]float64, normalized.EnrollFrames),
		candRMS:    make([]float64, normalized.EnrollFrames),
	}, nil
}

// FrameSamples is how many interleaved int16 values make up one analysis frame
// at the configured rate and channel count. Handy for sizing read buffers.
func (f *Filter) FrameSamples() int {
	return f.frameLen * f.ratio * f.cfg.Channels
}

// Enrolled reports whether the speaker profile has been built.
func (f *Filter) Enrolled() bool { return f.enrolled }

// Config returns the normalized configuration in use.
func (f *Filter) Config() Config { return f.cfg }

// Reset drops the enrolled profile, the VAD state and the hysteresis so the
// next voiced frames start a fresh enrollment.
func (f *Filter) Reset() {
	for i := range f.ring {
		f.ring[i] = 0
	}
	for i := range f.acc {
		f.acc[i] = 0
	}
	for i := range f.corr {
		f.corr[i] = 0
	}
	for i := range f.candF0 {
		f.candF0[i] = 0
		f.candRMS[i] = 0
	}
	f.ringPos = 0
	f.accLen = 0
	f.decSum = 0
	f.decN = 0
	f.noiseFloor = noiseFloorInit
	f.candN = 0
	f.enrollFrames = 0
	f.enrolled = false
	f.mu = 0
	f.sigma = 0
	f.refRMS = 0
	f.active = false
}

// Process feeds interleaved PCM samples and calls emit once for every completed
// 16 ms analysis frame. emit may be nil when the caller only wants the internal
// state (e.g. enrollment) advanced. Process does not allocate.
func (f *Filter) Process(samples []int16, emit func(Verdict)) {
	channels := f.cfg.Channels
	last := len(samples) - channels
	for i := 0; i <= last; i += channels {
		var mono float64
		if channels == 1 {
			mono = float64(samples[i]) / 32768
		} else {
			mono = (float64(samples[i]) + float64(samples[i+1])) / 65536
		}

		if f.ratio > 1 {
			f.decSum += mono
			f.decN++
			if f.decN < f.ratio {
				continue
			}
			mono = f.decSum / float64(f.ratio)
			f.decSum = 0
			f.decN = 0
		}

		f.acc[f.accLen] = mono
		f.accLen++
		if f.accLen < f.frameLen {
			continue
		}
		f.accLen = 0
		for _, value := range f.acc {
			f.ring[f.ringPos] = value
			f.ring[f.ringPos+ringSize] = value
			f.ringPos++
			if f.ringPos == ringSize {
				f.ringPos = 0
			}
		}
		// The pipeline always runs so that enrollment, the noise floor and the
		// hysteresis advance even when the caller drops the verdict.
		verdict := f.analyze()
		if emit != nil {
			emit(verdict)
		}
	}
}

// analyze runs the three-stage pipeline on the newest frame in the ring buffer.
func (f *Filter) analyze() Verdict {
	window := f.window()
	frame := window[ringSize-f.frameLen:]

	verdict := Verdict{
		RMS: rmsOf(frame),
		ZCR: zeroCrossingRate(frame),
	}

	// Stage 1: VAD.
	threshold := math.Max(vadAbsMin, f.noiseFloor*vadFactor)
	if verdict.RMS < threshold || verdict.ZCR > zcrNoiseMax {
		f.trackNoiseFloor(verdict.RMS)
		f.active = false
		verdict.Reason = ReasonSilence
		return verdict
	}
	verdict.Voiced = true

	// Stage 2: pitch.
	verdict.F0Hz, verdict.Periodicity = f.estimatePitch(window)
	if verdict.Periodicity < f.cfg.VoicingMin {
		f.active = false
		verdict.Reason = ReasonUnvoiced
		return verdict
	}
	if verdict.F0Hz < f.cfg.MinF0Hz || verdict.F0Hz > f.cfg.MaxF0Hz {
		f.active = false
		verdict.Reason = ReasonPitchOutOfBand
		return verdict
	}

	// Stage 3: speaker tracking.
	verdict.IsUser, verdict.Score, verdict.Reason = f.judge(verdict.F0Hz, verdict.RMS)
	return verdict
}

// window returns the newest ringSize samples in chronological order. The mirror
// buffer keeps the slice contiguous without a copy.
func (f *Filter) window() []float64 {
	start := f.ringPos
	if start == 0 {
		start = ringSize
	}
	return f.ring[start : start+ringSize]
}

// trackNoiseFloor follows the quiet end of the signal with an exponential moving
// average. It is only updated on frames the VAD rejected, so speech cannot drag
// the floor up.
func (f *Filter) trackNoiseFloor(rms float64) {
	f.noiseFloor += noiseFloorAlpha * (rms - f.noiseFloor)
	if f.noiseFloor < noiseFloorMin {
		f.noiseFloor = noiseFloorMin
	}
}

// estimatePitch measures F0 with a normalized autocorrelation over the lag band
// [minLag, maxLag]. The shortest strong peak wins, which stops a periodic
// signal from being reported at 2x or 3x its period.
func (f *Filter) estimatePitch(window []float64) (f0 float64, periodicity float64) {
	n := f.corrLen

	// The leading window is identical for every lag, so its energy is hoisted.
	var energyA float64
	for i := 0; i < n; i++ {
		energyA += window[i] * window[i]
	}
	if energyA <= energyEpsilon {
		return 0, 0
	}

	bestIndex := 0
	bestValue := math.Inf(-1)
	for lag := f.minLag; lag <= f.maxLag; lag++ {
		var num, energyB float64
		for i := 0; i < n; i++ {
			a := window[i]
			b := window[i+lag]
			num += a * b
			energyB += b * b
		}
		value := 0.0
		if den := math.Sqrt(energyA * energyB); den > energyEpsilon {
			value = num / den
		}
		f.corr[lag-f.minLag] = value
		if value > bestValue {
			bestValue = value
			bestIndex = lag - f.minLag
		}
	}
	if bestValue <= 0 {
		return 0, 0
	}

	// Prefer the earliest local peak that is nearly as strong as the global one.
	target := bestValue * 0.9
	chosen := bestIndex
	for index := 1; index < len(f.corr)-1; index++ {
		value := f.corr[index]
		if value < target || value < f.cfg.VoicingMin {
			continue
		}
		if value >= f.corr[index-1] && value >= f.corr[index+1] {
			chosen = index
			break
		}
	}

	lag := float64(f.minLag) + interpolatePeak(f.corr, chosen)
	if lag <= 0 {
		return 0, 0
	}
	periodicity = bestValue
	if periodicity > 1 {
		periodicity = 1
	}
	return float64(analysisRate) / lag, periodicity
}

// interpolatePeak refines a correlation peak index with a parabolic fit, giving
// sub-sample lag accuracy (roughly 0.5 Hz at 120 Hz).
func interpolatePeak(corr []float64, index int) float64 {
	if index <= 0 || index >= len(corr)-1 {
		return float64(index)
	}
	left, center, right := corr[index-1], corr[index], corr[index+1]
	denominator := left - 2*center + right
	if math.Abs(denominator) < energyEpsilon {
		return float64(index)
	}
	delta := 0.5 * (left - right) / denominator
	if delta > 0.5 {
		delta = 0.5
	}
	if delta < -0.5 {
		delta = -0.5
	}
	return float64(index) + delta
}

// judge compares one voiced, in-band frame against the enrolled profile and
// returns the decision plus the reason. It also advances the profile.
func (f *Filter) judge(f0, rms float64) (isUser bool, score float64, reason string) {
	if !f.enrolled {
		f.enroll(f0, rms)
		return false, 0, ReasonEnrolling
	}

	band := math.Max(f.sigma, math.Max(minSigmaHz, sigmaRelativeMin*f.mu)) * f.cfg.PitchSigmas
	deviation := math.Abs(f0 - f.mu)
	pitchScore := clamp01(1 - deviation/band)
	levelScore := clamp01(rms / f.refRMS)
	score = pitchWeight*pitchScore + levelWeight*levelScore

	if deviation > band {
		f.active = false
		return false, score, ReasonPitchOutOfBand
	}
	if rms < f.refRMS*volumeGateRatio {
		f.active = false
		return false, score, ReasonTooFar
	}

	if f.active {
		if score < exitThreshold {
			f.active = false
		}
	} else if score >= enterThreshold {
		f.active = true
	}
	if !f.active {
		// Below the hysteresis floor: report whichever half of the score failed
		// harder so the caller can tell a wrong pitch from a wrong distance.
		if pitchScore < levelScore {
			return false, score, ReasonPitchOutOfBand
		}
		return false, score, ReasonTooFar
	}

	f.mu += profileAlphaPitch * (f0 - f.mu)
	f.sigma += profileAlphaPitch * (deviation - f.sigma)
	if f.sigma < minSigmaHz {
		f.sigma = minSigmaHz
	}
	f.refRMS += profileAlphaLevel * (rms - f.refRMS)
	return true, score, ReasonUser
}

// enrollSettleFrames is the number of voiced in-band frames the enrollment
// window stays open for. The candidate array fills after EnrollFrames, but the
// window keeps accepting louder replacements until this many frames have passed.
func (f *Filter) enrollSettleFrames() int {
	return f.cfg.EnrollFrames * enrollSettleFactor
}

// enroll keeps the loudest EnrollFrames frames seen so far and freezes the
// profile once the settle window closes. Keeping the loudest frames biases the
// profile towards the talker's close-mic speech and away from room noise that
// slipped past the VAD.
func (f *Filter) enroll(f0, rms float64) {
	limit := f.cfg.EnrollFrames
	f.enrollFrames++
	if f.candN < limit {
		f.candF0[f.candN] = f0
		f.candRMS[f.candN] = rms
		f.candN++
	} else {
		worst := 0
		for i := 1; i < f.candN; i++ {
			if f.candRMS[i] < f.candRMS[worst] {
				worst = i
			}
		}
		if rms > f.candRMS[worst] {
			f.candF0[worst] = f0
			f.candRMS[worst] = rms
		}
	}
	if f.enrollFrames < f.enrollSettleFrames() {
		return
	}
	f.finalizeProfile()
}

// finalizeProfile turns the collected candidates into the enrolled profile.
func (f *Filter) finalizeProfile() {
	count := float64(f.candN)
	if count == 0 {
		return
	}
	var sumF0, sumRMS float64
	for i := 0; i < f.candN; i++ {
		sumF0 += f.candF0[i]
		sumRMS += f.candRMS[i]
	}
	mu := sumF0 / count

	var sumSquares float64
	for i := 0; i < f.candN; i++ {
		delta := f.candF0[i] - mu
		sumSquares += delta * delta
	}
	sigma := math.Sqrt(sumSquares / count)
	if sigma < minSigmaHz {
		sigma = minSigmaHz
	}

	f.mu = mu
	f.sigma = sigma
	f.refRMS = sumRMS / count
	f.enrolled = true
	f.active = false
}

// rmsOf returns the root-mean-square level of a mono frame.
func rmsOf(frame []float64) float64 {
	if len(frame) == 0 {
		return 0
	}
	var sum float64
	for _, value := range frame {
		sum += value * value
	}
	return math.Sqrt(sum / float64(len(frame)))
}

// zeroCrossingRate counts sign changes per sample, in 0..1.
func zeroCrossingRate(frame []float64) float64 {
	if len(frame) < 2 {
		return 0
	}
	crossings := 0
	previous := frame[0]
	for _, value := range frame[1:] {
		if (previous < 0 && value >= 0) || (previous >= 0 && value < 0) {
			crossings++
		}
		previous = value
	}
	return float64(crossings) / float64(len(frame)-1)
}

func clamp01(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}
