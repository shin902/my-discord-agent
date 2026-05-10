# サンドボックス環境比較

> 調査日：2026-05-10

## 比較対象

1. **Docker Sandbox 自作**（dockerode等でコンテナ制御）
2. **microsandbox**（github.com/superradcompany/microsandbox）
3. **@anthropic-ai/sandbox-runtime**（npmパッケージ）

---

## アーキテクチャの違い

| 方式 | 隔離レイヤー | 起動時間 | コンテナ/VM不要 |
|------|------------|---------|----------------|
| Docker DIY | 共有カーネル（Namespaces + cgroups + seccomp） | ミリ秒（イメージキャッシュ後） | ❌ Docker daemon必要 |
| microsandbox | microVM（独立カーネル、libkrun） | **100ms以下** | ❌ KVM/Hypervisor必要 |
| sandbox-runtime | OSプリミティブ（sandbox-exec / bubblewrap） | **0ms相当** | ✅ プロセスラップのみ |

---

## セキュリティ強度

```
強 ←──────────────────────────────────────→ 弱

microsandbox  >  Docker DIY（適切設定）  >  sandbox-runtime
（ハードウェア隔離）  （多層防御）           （OS機能依存）
```

### Docker DIY
- Namespaces / cgroups / seccomp / AppArmor の組み合わせ
- ホストと**カーネルを共有する**ため、カーネル脆弱性にはノーガード
- 2025年にDocker Desktop でCVSSスコア9.3の重大脆弱性（CVE-2025-9074）が発見されている

### microsandbox
- 各サンドボックスが**独自のLinuxカーネル**を持つ → カーネルエスケープが原理的に不可能
- libkrunのTSI（Transparent Socket Impersonation）でネットワークオーバーヘッドを最小化
- シークレットはVMに入れず、ネットワーク層でプレースホルダー置換する設計
- ⚠️ セキュリティ監査は未実施（予定段階）

### @anthropic-ai/sandbox-runtime
- macOS：`sandbox-exec`（Seatbelt） → **Appleが2017年に非推奨化したAPI**
- Linux：`bubblewrap` + seccomp BPF
- Docker内で使用すると `enableWeakerNestedSandbox` モードになり**セキュリティが大幅低下**
- ネットワーク制限はHTTPプロキシ + SOCKS5プロキシの二層構造

---

## 実装難易度と TypeScript 適合性

### @anthropic-ai/sandbox-runtime（最も簡単）

```bash
npm install -g @anthropic-ai/sandbox-runtime
# Linux の場合は追加で bubblewrap / socat / ripgrep が必要
```

```typescript
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { spawn } from 'child_process'

const config: SandboxRuntimeConfig = {
  network: {
    allowedDomains: ['api.anthropic.com', '*.anthropic.com'],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ['~/.ssh'],
    allowWrite: ['.', '/tmp'],
    denyWrite: ['.env'],
  },
}

await SandboxManager.initialize(config)
const cmd = await SandboxManager.wrapWithSandbox('node agent.js')
const child = spawn(cmd, { shell: true, stdio: 'inherit' })
child.on('exit', async () => { await SandboxManager.reset() })
```

**重要な制約**：`tsx`（TypeScript直接実行）はUnixソケットを使うためサンドボックスに遮断される。
TypeScriptは事前コンパイル → `node`で実行する形が必要。

---

### microsandbox（中程度）

```bash
npm i microsandbox
# Node.js 22以上が必須（await using / Symbol.asyncDispose）
```

```typescript
import { Sandbox } from "microsandbox"

await using sandbox = await Sandbox.builder("my-sandbox")
  .image("node:22-alpine")   // 任意のOCIイメージ
  .cpus(1)
  .memory(512)
  .create()

const result = await sandbox.exec("node", ["-e", "console.log('safe')"])
console.log(result.stdout())
```

---

### Docker DIY（最も複雑）

```bash
npm install dockerode
npm install -D @types/dockerode
```

```typescript
import Docker from 'dockerode'

const docker = new Docker()

async function runInSandbox(code: string): Promise<string> {
  const container = await docker.createContainer({
    Image: 'node:22-alpine',
    Cmd: ['node', '-e', code],
    HostConfig: {
      Memory: 128 * 1024 * 1024,
      CpuQuota: 50000,
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges'],
    },
    NetworkDisabled: true,
  })
  await container.start()
  const logs = await container.logs({ stdout: true, stderr: true, follow: true })
  await container.remove({ force: true })
  return logs.toString()
}
```

セキュリティ設定（seccomp プロファイル、AppArmor、ネットワークポリシー等）をすべて自前で実装・検証する責任が生じる。

---

## プラットフォーム対応

| 環境 | Docker DIY | microsandbox | sandbox-runtime |
|------|-----------|-------------|----------------|
| Linux (x86_64) | ✅ | ✅（KVM必須） | ✅ |
| macOS Apple Silicon | ✅ | ✅ | ✅ |
| macOS Intel | ✅ | ❌ | ✅ |
| Windows | ✅（WSL2） | ❌（計画中） | ❌ |
| Docker内（DinD） | ⚠️（--privileged必要） | ❌ | ⚠️（弱モード） |
| CI/CDクラウド | ✅ | ⚠️（KVM対応必須） | ✅ |

---

## プロジェクト成熟度

| 観点 | Docker DIY | microsandbox | sandbox-runtime |
|------|-----------|-------------|----------------|
| 安定性 | ✅ 成熟（10年以上） | ⚠️ ベータ（v0.1.0、2025-05） | ⚠️ Research Preview |
| セキュリティ監査 | ✅ 多数 | ❌ 未実施 | ❌ 未実施 |
| 破壊的変更リスク | 低 | 高（明示的に警告あり） | 高 |
| 長期メンテナンス | ✅ | ❓ 未知数 | ⚠️ experimental |

---

## 結論・推奨

| 用途 | 推奨 |
|------|------|
| **最速で実装したい** | `@anthropic-ai/sandbox-runtime` |
| **セキュリティを最優先**（KVM/Apple Silicon環境あり） | `microsandbox` |
| **長期本番運用・汎用性重視** | Docker DIY |

### このプロジェクト（my-discord-agent）での判断軸

- **macOS Intel や Windows での動作が必要**なら microsandbox は脱落
- **Docker内でエージェントが動作**する場合は sandbox-runtime のセキュリティが大幅に低下する点に注意
- **AIエージェントが生成したコードを実行**するユースケースでは、セキュリティ強度の観点から microsandbox が最適だが、本番利用はベータ版が安定してから検討を推奨

---

## 参考リンク

- [microsandbox GitHub](https://github.com/superradcompany/microsandbox)
- [sandbox-runtime GitHub](https://github.com/anthropic-experimental/sandbox-runtime)
- [Comparing Sandboxing Approaches for AI Agents | Docker公式](https://www.docker.com/blog/comparing-sandboxing-approaches-ai-agents/)
- [Microsandbox on Hacker News](https://news.ycombinator.com/item?id=44135977)
- [CVE-2025-9074 Docker Desktop 脆弱性](https://www.mindpatch.net/posts/docker-escape-ssrf/)
