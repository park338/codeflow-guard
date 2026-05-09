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
node scripts/collect-review-context.js --demo-project
```

## 风险等级

- P0：阻断合并，可能导致严重安全、数据、资金、隐私或生产事故
- P1：高风险，必须修复或补充验证
- P2：中风险，建议修复或补充测试
- P3：低风险，优化建议

## 输出硬约束

- 使用中文输出。
- 严格使用 `references/output-template.md` 的分节顺序，不要省略任何必填章节。
- 如果最终报告缺少“审查上下文”“风险计数”“Top 3 必须修复项”“关键风险”“测试建议”“合并前检查清单”“复审标准”中的任一章节，必须在输出前自行重写。
- 结论区必须一项一行，禁止把“合并建议、总体风险、一句话摘要”挤在同一行。
- 避免宽表格。关键风险使用卡片式条目，方便窄窗口阅读。
- 顶部一句话摘要控制在 35 个汉字以内，只写最核心风险，不堆叠长句。
- 引用仓库根目录下的相对路径。优先使用 `Changed Line Anchors` 和 `Current File Snapshots` 中的当前文件行号。
- Top 3 和每个关键风险标题必须包含 `path:line`；如果是删除行导致的风险，使用 `path:旧行号` 并在证据里标注“删除行”。
- 如果行号无法确认，只写文件路径和函数名，不要编造行号。
- `Sensitive Literal Findings` 中的每一项都必须进入“关键风险”和风险计数；其中 hardcoded key/token/secret/password/connection string 默认按 P0 处理，除非上下文证明只是无害测试 fixture。
- 敏感证据只能引用脚本输出的脱敏值，不要在报告中展示完整密钥、令牌、密码或连接串。
- Top 3 候选必须优先考虑：认证绕过、硬编码密钥/令牌、数据/资金风险、关键测试被跳过。
- “测试覆盖率”只能在采集上下文出现 coverage 工具结果时使用；否则只能写“通过/失败/跳过数量”。
- 发现 `test.skip`、`describe.skip`、`it.skip` 或测试输出存在 skipped 时，必须列为测试风险。
- 只有 `Syntax Check`、测试输出或构建输出明确失败时，才能写语法错误、解析失败或应用无法启动。
- 只基于代码变更、测试结果和采集上下文中的证据下结论。
- 最后给出“可合并 / 补测后合并 / 不建议合并”的判断和复审标准。

## 输出前自检

最终回答前逐项检查：

1. 结论区是否分行展示合并建议、总体风险、摘要、风险计数、测试结果。
2. 是否包含审查上下文中的采集命令、测试命令和 Diff 检查结果。
3. 是否包含 Top 3 必须修复项，且每项都有 `path:line`。
4. 关键风险是否使用卡片式条目，并包含风险、证据、影响、建议、推荐测试。
5. `Sensitive Literal Findings` 是否全部进入关键风险和风险计数。
6. 是否明确 skipped 测试数量，且没有误写成覆盖率。
7. 是否包含合并前检查清单和复审标准。
