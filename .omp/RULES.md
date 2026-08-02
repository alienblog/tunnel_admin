---
alwaysApply: true
---
# 提交前更新 README 用量

每次 git 提交前必须运行 `node scripts/update-usage.cjs`，它自动统计 `~/.omp/agent/sessions/-sources-tunneladmin/*.jsonl` 的 token 用量（每个 jsonl = 一次会话，新会话自动累加到累计），并同步更新 `README.md` 与 `readme_en.md` 的「开发统计」表格。若 PATH 中无 node，用 `$HOME/.local/node/bin/node`。git pre-commit hook（scripts/git-hooks/）已自动执行该步骤；若 hook 未运行（如暂存区为空、跳过提交），需手动执行后再提交。
