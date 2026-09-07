# my-discord-agent

Discord上のAgentによる作業と、そのAgentに許可する機能を扱う。以下はTool実行境界について合意した用語であり、実装済み機能の一覧ではない。

## Language

**Agent run**:
Agentが一つの作業を実行する単位。一つのrunは複数のTool callを含み得る。
_Avoid_: Tool callとの同一視

**Capability**:
Agent runに利用を許可できる、名前と入力・結果の契約を持つ機能。
_Avoid_: Skillの説明文、実行用container

**Native Tool**:
Capabilityをモデルの構造化Tool呼び出しとして提示する入口。
_Avoid_: Capability全体との同一視

**Skill**:
Agentへ作業手順を提示するもの。一つのSkillは複数のCapabilityを利用し得る。
_Avoid_: 独立した実行権限、独立したRuntime

**Tool call**:
一つのCapabilityの一回の実行。Native ToolとSkillからの呼び出しを共に含む。
_Avoid_: Agent runとの同一視

**Tool Proxy**:
Agent runに許可されたCapabilityの実行を取り扱う認可境界。
_Avoid_: Credential Proxyとの同一視

**Tool Runtime**:
Agent自身の作業環境から分離した、Tool実装の実行環境。
_Avoid_: Agent sandbox、agent-reach専用Runtime

**Agent sandbox**:
Agentが自分の作業を進めるための実行環境。
_Avoid_: Tool Runtime

**Credential Proxy**:
Agentへ秘密値を渡さずに、上流サービスへ認証情報を付与して接続するための境界。
_Avoid_: Capabilityの認可境界

**Runtime private scratch**:
Tool実装が処理の途中で使い、Agentへ直接公開しない作業データ。
_Avoid_: Agentの成果物

**Agentの成果物**:
Agentが取得結果を再利用・保存するために保持する作業データ。
_Avoid_: Runtime private scratch
