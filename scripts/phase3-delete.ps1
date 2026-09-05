$ErrorActionPreference = 'Stop'

$targets = @(
  'alibaba','anthropic','anthropic-vertex','byteplus','chutes',
  'cloudflare-ai-gateway','deepseek','fireworks','groq','huggingface',
  'kilocode','kimi-coding','litellm','microsoft','microsoft-foundry',
  'minimax','mistral','moonshot','nvidia','ollama',
  'opencode','opencode-go','openrouter','qianfan','qwen',
  'sglang','stepfun','synthetic','together','venice',
  'vercel-ai-gateway','vllm','volcengine','xai','xiaomi',
  'elevenlabs','copilot-proxy','perplexity','comfy','fal','runway'
)

$deleted = 0
$missing = @()
foreach ($t in $targets) {
  if (Test-Path "extensions\$t") {
    Remove-Item "extensions\$t" -Recurse -Force
    $deleted++
  } else {
    $missing += $t
  }
}
Write-Host "Deleted folders: $deleted / $($targets.Count)"
if ($missing.Count -gt 0) { Write-Host "MISSING (not found): $($missing -join ', ')" }

$liveTests = @('extensions\music-generation-providers.live.test.ts','extensions\video-generation-providers.live.test.ts')
foreach ($f in $liveTests) {
  if (Test-Path $f) {
    Remove-Item $f -Force
    Write-Host "Deleted: $f"
  } else {
    Write-Host "MISSING (not found): $f"
  }
}
