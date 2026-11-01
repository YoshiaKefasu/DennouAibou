package audio

import (
	"math"
	"math/rand"
	"testing"
)

// newTestFilter builds a filter with the default config, failing the test on
// error.
func newTestFilter(t *testing.T, mutate func(*Config)) *Filter {
	t.Helper()
	cfg := DefaultConfig()
	if mutate != nil {
		mutate(&cfg)
	}
	filter, err := NewFilter(cfg)
	if err != nil {
		t.Fatalf("NewFilter: %v", err)
	}
	return filter
}

// settleFrames is how many voiced in-band frames a filter needs before its
// profile freezes (EnrollFrames × enrollSettleFactor).
func settleFrames(t *testing.T, filter *Filter) int {
	t.Helper()
	return filter.enrollSettleFrames()
}

// enrollProfile feeds enough voiced frames to complete enrollment and fails the
// test if the profile did not freeze.
func enrollProfile(t *testing.T, filter *Filter, freq, amp float64) {
	t.Helper()
	runSine(t, filter, freq, amp, settleFrames(t, filter))
	if !filter.Enrolled() {
		t.Fatalf("profile not enrolled after %d voiced frames", settleFrames(t, filter))
	}
}

// sineSource generates a phase-continuous sine wave as interleaved int16 PCM.
type sineSource struct {
	rate     int
	channels int
	freq     float64
	amp      float64
	phase    float64
}

func (s *sineSource) fill(dst []int16) {
	for i := 0; i+s.channels <= len(dst); i += s.channels {
		value := s.amp * math.Sin(s.phase)
		s.phase += 2 * math.Pi * s.freq / float64(s.rate)
		if s.phase > 2*math.Pi {
			s.phase -= 2 * math.Pi
		}
		sample := int16(math.Round(value * 32767))
		for channel := 0; channel < s.channels; channel++ {
			dst[i+channel] = sample
		}
	}
}

// runSine feeds `frames` analysis frames of a sine wave and returns every
// verdict.
func runSine(t *testing.T, filter *Filter, freq, amp float64, frames int) []Verdict {
	t.Helper()
	cfg := filter.Config()
	source := &sineSource{
		rate:     cfg.SampleRate,
		channels: cfg.Channels,
		freq:     freq,
		amp:      amp,
	}
	buffer := make([]int16, filter.FrameSamples())
	verdicts := make([]Verdict, 0, frames)
	for i := 0; i < frames; i++ {
		source.fill(buffer)
		filter.Process(buffer, func(verdict Verdict) {
			verdicts = append(verdicts, verdict)
		})
	}
	if len(verdicts) != frames {
		t.Fatalf("verdicts = %d, want %d (one per fed frame)", len(verdicts), frames)
	}
	return verdicts
}

func TestEnrollsThenAcceptsUserPitch(t *testing.T) {
	filter := newTestFilter(t, nil)
	settle := settleFrames(t, filter)
	verdicts := runSine(t, filter, 120, 0.3, settle+10)

	for index := 0; index < settle; index++ {
		verdict := verdicts[index]
		if verdict.IsUser {
			t.Fatalf("frame %d: enrollment must be fail-closed, got IsUser=true", index)
		}
		if verdict.Reason != ReasonEnrolling {
			t.Fatalf("frame %d: reason = %q, want %q", index, verdict.Reason, ReasonEnrolling)
		}
		if !verdict.Voiced {
			t.Fatalf("frame %d: a 120 Hz sine must pass the VAD", index)
		}
	}
	if !filter.Enrolled() {
		t.Fatalf("profile not enrolled after %d voiced frames", settle)
	}

	for index := settle; index < len(verdicts); index++ {
		verdict := verdicts[index]
		if !verdict.IsUser {
			t.Fatalf("frame %d: enrolled user rejected (reason=%q score=%.3f)", index, verdict.Reason, verdict.Score)
		}
		if verdict.Reason != ReasonUser {
			t.Fatalf("frame %d: reason = %q, want %q", index, verdict.Reason, ReasonUser)
		}
		if verdict.Score < 0.9 {
			t.Fatalf("frame %d: score = %.3f, want >= 0.9 for a matching frame", index, verdict.Score)
		}
		if math.Abs(verdict.F0Hz-120) > 3 {
			t.Fatalf("frame %d: F0 = %.2f Hz, want ~120 Hz", index, verdict.F0Hz)
		}
		if verdict.Periodicity < 0.9 {
			t.Fatalf("frame %d: periodicity = %.3f, want >= 0.9 for a clean sine", index, verdict.Periodicity)
		}
	}
}

func TestMeasuresPitchOf200Hz(t *testing.T) {
	filter := newTestFilter(t, nil)
	verdicts := runSine(t, filter, 200, 0.3, 5)
	for index, verdict := range verdicts {
		if math.Abs(verdict.F0Hz-200) > 4 {
			t.Fatalf("frame %d: F0 = %.2f Hz, want ~200 Hz", index, verdict.F0Hz)
		}
		if !verdict.Voiced {
			t.Fatalf("frame %d: a 200 Hz sine must pass the VAD", index)
		}
	}
}

func TestRejectsOutOfBandPitch(t *testing.T) {
	filter := newTestFilter(t, nil)
	verdicts := runSine(t, filter, 400, 0.3, 40)
	for index, verdict := range verdicts {
		if verdict.IsUser {
			t.Fatalf("frame %d: 400 Hz must never be the enrolled user", index)
		}
		if verdict.Reason != ReasonPitchOutOfBand {
			t.Fatalf("frame %d: reason = %q (F0=%.1f), want %q", index, verdict.Reason, verdict.F0Hz, ReasonPitchOutOfBand)
		}
		if verdict.F0Hz < 380 || verdict.F0Hz > 420 {
			t.Fatalf("frame %d: F0 = %.1f Hz, want ~400 Hz so the fold onto 200 Hz is avoided", index, verdict.F0Hz)
		}
	}
	if filter.Enrolled() {
		t.Fatalf("out-of-band pitch must not enroll a profile")
	}
}

func TestRejectsWhiteNoise(t *testing.T) {
	filter := newTestFilter(t, nil)
	random := rand.New(rand.NewSource(7))
	buffer := make([]int16, filter.FrameSamples())
	for frame := 0; frame < 60; frame++ {
		for index := range buffer {
			buffer[index] = int16((random.Float64()*2 - 1) * 0.5 * 32767)
		}
		var verdict Verdict
		filter.Process(buffer, func(result Verdict) { verdict = result })
		if verdict.IsUser {
			t.Fatalf("frame %d: white noise must never be the user (score=%.3f)", frame, verdict.Score)
		}
		if verdict.Reason != ReasonUnvoiced && verdict.Reason != ReasonSilence {
			t.Fatalf("frame %d: reason = %q, want unvoiced or silence", frame, verdict.Reason)
		}
	}
	if filter.Enrolled() {
		t.Fatalf("white noise must not build a speaker profile")
	}
}

func TestSilenceIsReportedAsSilence(t *testing.T) {
	filter := newTestFilter(t, nil)
	buffer := make([]int16, filter.FrameSamples())
	var verdict Verdict
	filter.Process(buffer, func(result Verdict) { verdict = result })
	if verdict.Voiced {
		t.Fatalf("digital silence must not be voiced")
	}
	if verdict.Reason != ReasonSilence {
		t.Fatalf("reason = %q, want %q", verdict.Reason, ReasonSilence)
	}
	if verdict.RMS != 0 || verdict.F0Hz != 0 || verdict.IsUser {
		t.Fatalf("silence verdict = %+v, want RMS 0, F0 0, IsUser false", verdict)
	}
}

func TestStereo48kHzInputIsDownmixedAndDecimated(t *testing.T) {
	filter := newTestFilter(t, func(cfg *Config) {
		cfg.SampleRate = 48000
		cfg.Channels = 2
	})
	if got, want := filter.FrameSamples(), 768*2; got != want {
		t.Fatalf("FrameSamples() = %d, want %d", got, want)
	}
	verdicts := runSine(t, filter, 120, 0.3, settleFrames(t, filter)+10)
	if !filter.Enrolled() {
		t.Fatalf("48 kHz stereo input did not enroll")
	}
	last := verdicts[len(verdicts)-1]
	if !last.IsUser {
		t.Fatalf("48 kHz stereo user rejected (reason=%q score=%.3f)", last.Reason, last.Score)
	}
	if math.Abs(last.F0Hz-120) > 3 {
		t.Fatalf("F0 = %.2f Hz after 3:1 decimation, want ~120 Hz", last.F0Hz)
	}
}

func TestDifferentPitchIsRejected(t *testing.T) {
	filter := newTestFilter(t, nil)
	enrollProfile(t, filter, 120, 0.3)
	verdicts := runSine(t, filter, 200, 0.3, 5)
	// The autocorrelation window is 512 samples (32 ms), so the first two frames
	// after an instant pitch change still contain the previous talker. Skip them
	// and require every flushed frame to be rejected.
	for index, verdict := range verdicts[2:] {
		if verdict.IsUser {
			t.Fatalf("frame %d: 200 Hz talker accepted over a 120 Hz profile (F0=%.1f)", index+2, verdict.F0Hz)
		}
		if verdict.Reason != ReasonPitchOutOfBand {
			t.Fatalf("frame %d: reason = %q, want %q", index+2, verdict.Reason, ReasonPitchOutOfBand)
		}
		if math.Abs(verdict.F0Hz-200) > 4 {
			t.Fatalf("frame %d: F0 = %.2f Hz, want ~200 Hz", index+2, verdict.F0Hz)
		}
	}
}

func TestQuietTalkerIsRejectedAsTooFar(t *testing.T) {
	filter := newTestFilter(t, nil)
	enrollProfile(t, filter, 120, 0.3)
	verdicts := runSine(t, filter, 120, 0.02, 5)
	for index, verdict := range verdicts {
		if verdict.IsUser {
			t.Fatalf("frame %d: -24 dB below the enrolled level accepted", index)
		}
		if verdict.Reason != ReasonTooFar {
			t.Fatalf("frame %d: reason = %q, want %q (RMS=%.4f)", index, verdict.Reason, ReasonTooFar, verdict.RMS)
		}
		if !verdict.Voiced {
			t.Fatalf("frame %d: the quiet frame should still be voiced", index)
		}
	}
}

func TestResetReturnsToEnrolling(t *testing.T) {
	filter := newTestFilter(t, nil)
	enrollProfile(t, filter, 120, 0.3)

	filter.Reset()
	if filter.Enrolled() {
		t.Fatalf("Reset must drop the profile")
	}
	verdicts := runSine(t, filter, 120, 0.3, 1)
	if verdicts[0].Reason != ReasonEnrolling || verdicts[0].IsUser {
		t.Fatalf("after Reset: verdict = %+v, want fail-closed enrolling", verdicts[0])
	}
}

func TestProcessIsAllocationFree(t *testing.T) {
	filter := newTestFilter(t, nil)
	source := &sineSource{rate: 16000, channels: 1, freq: 120, amp: 0.3}
	buffer := make([]int16, filter.FrameSamples())
	sink := func(Verdict) {}

	// Warm up so enrollment and the ring buffer are already exercised.
	for i := 0; i < settleFrames(t, filter)+10; i++ {
		source.fill(buffer)
		filter.Process(buffer, sink)
	}

	allocs := testing.AllocsPerRun(50, func() {
		source.fill(buffer)
		filter.Process(buffer, sink)
	})
	if allocs != 0 {
		t.Fatalf("Process allocated %.2f times per frame, want 0", allocs)
	}
}

func TestNewFilterRejectsUnsupportedConfig(t *testing.T) {
	cases := map[string]Config{
		"sample rate": {SampleRate: 44100},
		"channels":    {Channels: 3},
		"frame":       {FrameMS: 20},
		"pitch band":  {MinF0Hz: 300, MaxF0Hz: 100},
		"f0 range":    {MinF0Hz: 20000, MaxF0Hz: 21000},
		"voicing":     {VoicingMin: 1.5},
	}
	for name, cfg := range cases {
		if _, err := NewFilter(cfg); err == nil {
			t.Fatalf("%s: NewFilter accepted an unsupported config: %+v", name, cfg)
		}
	}
}

func TestProcessWithNilEmitStillAdvancesEnrollment(t *testing.T) {
	filter := newTestFilter(t, nil)
	source := &sineSource{rate: 16000, channels: 1, freq: 120, amp: 0.3}
	buffer := make([]int16, filter.FrameSamples())
	for i := 0; i < settleFrames(t, filter); i++ {
		source.fill(buffer)
		filter.Process(buffer, nil)
	}
	if !filter.Enrolled() {
		t.Fatalf("Process(nil emit) must still advance enrollment, Enrolled() = false after %d frames", settleFrames(t, filter))
	}
}

func TestEnrollmentKeepsLoudestCandidates(t *testing.T) {
	filter := newTestFilter(t, func(cfg *Config) { cfg.EnrollFrames = 1 })
	settle := settleFrames(t, filter)
	if settle != 3 {
		t.Fatalf("enrollSettleFrames() = %d for EnrollFrames=1, want 3", settle)
	}

	// The candidate array fills on the quiet frame, the loud frame replaces it,
	// and the closing quiet frame is not loud enough to replace anything.
	runSine(t, filter, 120, 0.05, 1)
	runSine(t, filter, 120, 0.3, 1)
	runSine(t, filter, 120, 0.05, settle-2)
	if !filter.Enrolled() {
		t.Fatalf("profile not enrolled after %d voiced frames", settle)
	}
	// A 0.3 amplitude sine has an RMS of about 0.21; averaging it with the two
	// quiet frames (0.035) would land near 0.09.
	if filter.refRMS < 0.18 {
		t.Fatalf("refRMS = %.4f, want the loud candidate to survive the settle window", filter.refRMS)
	}
}

func TestFrameSamplesMatchesConfig(t *testing.T) {
	cases := []struct {
		rate     int
		channels int
		want     int
	}{
		{16000, 1, 256},
		{48000, 1, 768},
		{48000, 2, 1536},
	}
	for _, testCase := range cases {
		filter := newTestFilter(t, func(cfg *Config) {
			cfg.SampleRate = testCase.rate
			cfg.Channels = testCase.channels
		})
		if got := filter.FrameSamples(); got != testCase.want {
			t.Fatalf("%d Hz / %d ch: FrameSamples() = %d, want %d", testCase.rate, testCase.channels, got, testCase.want)
		}
	}
}
