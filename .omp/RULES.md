---
alwaysApply: true
---
# 积极使用工具解决

遇到问题、疑问或不确定的信息时，优先调用工具实证解决，而非停留在推理或猜测：

- 不确定代码行为 → 用 `read`/`grep`/`lsp` 查源码或运行 `eval` 验证，不要凭记忆下结论。
- 需要确认环境状态 → 用 `bash` 检查文件、进程、网络等实际情况。
- 修改前先查调用方：改动导出符号或接口前必须用 `lsp references`/`grep` 找出全部调用点。
- 可以并行时并行：多个无依赖的工具调用在同一条消息中一起发出，减少往返。
- 验证优先：任何非平凡改动完成后，用具体命令或场景跑一遍证明可用，而非口头断言。
- 宁可多调一次工具，也不要交付未经证实的结果。

# 提交前更新 README 用量

每次 git 提交前必须运行 `node scripts/update-usage.cjs`，它自动统计 `~/.omp/agent/sessions/-sources-tunneladmin/*.jsonl` 的 token 用量（每个 jsonl = 一次会话，新会话自动累加到累计），并同步更新 `README.md` 与 `readme_en.md` 的「开发统计」表格。若 PATH 中无 node，用 `$HOME/.local/node/bin/node`。git pre-commit hook（scripts/git-hooks/）已自动执行该步骤；若 hook 未运行（如暂存区为空、跳过提交），需手动执行后再提交。
