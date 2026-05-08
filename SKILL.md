---
name: codeflow-guard
description: 自动审查 Git 代码变更、PR、commit 或合并前改动，生成风险等级、测试建议和合并建议。适用于代码评审、发布前检查、研发质量保障等软件开发场景。
allowed-tools: Read, Grep, Bash(git:*), Bash(node:*), Bash(npm:*), Bash(pnpm:*), Bash(pytest:*), Bash(python:*)
---

# CodeFlow Guard

使用本 Skill 审查代码变更时，先稳定收集审查上下文，再按风险规则输出报告。

## 审查流程

1. 优先运行上下文采集脚本：
   `node scripts/collect-review-context.js`
2. 如果用户提供测试命令，传入脚本：
   `node scripts/collect-review-context.js --test-cmd "<test command>"`
3. 如果脚本不可用，再手动运行 `git status --short --branch`、`git diff --stat`、`git diff --name-status`、`git diff --check`、`git diff` 和相关测试命令。
4. 读取 `references/risk-rubric.md` 判断风险等级。
5. 读取 `references/output-template.md` 生成最终报告。

## Demo 项目提示

审查本仓库自带 Demo 时，使用：

```bash
node scripts/collect-review-context.js --test-cmd "npm test --prefix examples/demo-project"
```

## 风险等级

- P0：阻断合并，可能导致严重安全、数据、资金、隐私或生产事故
- P1：高风险，必须修复或补充验证
- P2：中风险，建议修复或补充测试
- P3：低风险，优化建议

## 输出硬约束

- 使用中文输出。
- 严格使用 `references/output-template.md` 的分节顺序，不要省略“审查上下文”和“风险计数”。
- 结论区必须一项一行，禁止把“合并建议、总体风险、一句话摘要”挤在同一行。
- 避免宽表格。关键风险使用卡片式条目，方便窄窗口阅读。
- 顶部一句话摘要控制在 35 个汉字以内，只写最核心风险，不堆叠长句。
- 引用仓库根目录下的相对路径。优先使用 `Current File Snapshots` 中的当前文件行号。
- 如果行号无法确认，只写文件路径和函数名，不要编造行号。
- “测试覆盖率”只能在采集上下文出现 coverage 工具结果时使用；否则只能写“通过/失败/跳过数量”。
- 发现 `test.skip`、`describe.skip`、`it.skip` 或测试输出存在 skipped 时，必须列为测试风险。
- 只基于代码变更、测试结果和采集上下文中的证据下结论。
- 最后给出“可合并 / 补测后合并 / 不建议合并”的判断和复审标准。
