# Dependency Graph

## Most Imported Files (change these carefully)

- `src\config\config.ts` — imported by **1471** files
- `src\runtime.ts` — imported by **328** files
- `src\utils.ts` — imported by **219** files
- `src\channels\plugins\types.ts` — imported by **184** files
- `src\routing\session-key.ts` — imported by **174** files
- `src\plugins\runtime.ts` — imported by **169** files
- `src\plugins\types.ts` — imported by **168** files
- `src\agents\agent-scope.ts` — imported by **159** files
- `src\config\sessions.ts` — imported by **155** files
- `src\logging\subsystem.ts` — imported by **127** files
- `src\auto-reply\templating.ts` — imported by **123** files
- `src\test-utils\env.ts` — imported by **119** files
- `src\config\types.ts` — imported by **115** files
- `src\channels\plugins\index.ts` — imported by **114** files
- `src\utils\message-channel.ts` — imported by **106** files
- `src\auto-reply\types.ts` — imported by **102** files
- `src\config\types.secrets.ts` — imported by **98** files
- `src\agents\auth-profiles.ts` — imported by **96** files
- `src\terminal\theme.ts` — imported by **95** files
- `src\globals.ts` — imported by **90** files

## Import Map (who imports what)

- `src\config\config.ts` ← `extensions\comfy\comfy.live.test.ts`, `extensions\discord\src\client.proxy.test.ts`, `extensions\discord\src\send.webhook.proxy.test.ts`, `extensions\google\web-search-provider.test.ts`, `extensions\image-generation-core\src\runtime.test.ts` +1466 more
- `src\runtime.ts` ← `src\agents\agent-command.ts`, `src\agents\channel-tools.test.ts`, `src\agents\command\delivery.ts`, `src\agents\sandbox\browser.ts`, `src\agents\sandbox\context.ts` +323 more
- `src\utils.ts` ← `packages\memory-host-sdk\src\host\backend-config.ts`, `packages\memory-host-sdk\src\host\embeddings.ts`, `src\acp\translator.ts`, `src\agents\agent-paths.ts`, `src\agents\agent-scope.ts` +214 more
- `src\channels\plugins\types.ts` ← `src\acp\persistent-bindings.test.ts`, `src\acp\persistent-bindings.types.ts`, `src\agents\channel-tools.test.ts`, `src\agents\channel-tools.ts`, `src\agents\command\delivery.test.ts` +179 more
- `src\routing\session-key.ts` ← `packages\memory-host-sdk\src\host\backend-config.ts`, `src\acp\control-plane\manager.core.ts`, `src\acp\persistent-bindings.types.ts`, `src\acp\persistent-bindings.types.ts`, `src\acp\policy.ts` +169 more
- `src\plugins\runtime.ts` ← `extensions\googlechat\src\monitor.webhook-routing.test.ts`, `extensions\telegram\src\bot-native-commands.registry.test.ts`, `extensions\telegram\src\bot-native-commands.registry.test.ts`, `src\acp\persistent-bindings.test.ts`, `src\agents\channel-tools.test.ts` +164 more
- `src\plugins\types.ts` ← `src\agents\models-config.providers.implicit.ts`, `src\agents\models-config.providers.implicit.ts`, `src\agents\models-config.providers.ollama-autodiscovery.test.ts`, `src\agents\models-config.providers.ollama.test.ts`, `src\agents\openai-transport-stream.ts` +163 more
- `src\agents\agent-scope.ts` ← `packages\memory-host-sdk\src\host\backend-config.test.ts`, `packages\memory-host-sdk\src\host\backend-config.ts`, `packages\memory-host-sdk\src\host\read-file.ts`, `src\acp\persistent-bindings.test.ts`, `src\agents\acp-spawn.ts` +154 more
- `src\config\sessions.ts` ← `extensions\discord\src\approval-native.test.ts`, `extensions\discord\src\monitor\exec-approvals.test.ts`, `extensions\telegram\src\approval-native.test.ts`, `extensions\telegram\src\bot.test.ts`, `extensions\telegram\src\bot.test.ts` +150 more
- `src\logging\subsystem.ts` ← `packages\memory-host-sdk\src\host\embeddings-debug.ts`, `packages\memory-host-sdk\src\host\qmd-query-parser.ts`, `packages\memory-host-sdk\src\host\session-files.ts`, `src\agents\acp-spawn.ts`, `src\agents\agent-command.ts` +122 more
