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

## 输出要求

- 使用中文输出。
- 只基于代码变更、测试结果和采集上下文中的证据下结论。
- 引用仓库根目录下的相对路径、函数名、配置项或变更点。
- 顶部一句话摘要控制在 50 个汉字以内。
- 单独列出 Top 3 必须修复项。
- 最后给出“可合并 / 补测后合并 / 不建议合并”的判断和复审标准。
