---
name: codeflow-guard
description: 自动审查 Git 代码变更、PR、commit 或合并前改动，生成风险等级、测试建议和合并建议。适用于代码评审、发布前检查、研发质量保障等软件开发场景。
allowed-tools: Read, Grep, Bash(git:*), Bash(npm:*), Bash(pnpm:*), Bash(pytest:*), Bash(python:*)
---

# CodeFlow Guard

使用本 Skill 审查代码变更时，按以下流程执行。

1. 查看当前仓库状态：`git status`
2. 查看变更概览：`git diff --stat`
3. 查看文件变更类型：`git diff --name-status`
4. 查看具体改动：`git diff`
5. 按风险规则分析安全、权限、接口兼容、数据变更、依赖、配置、性能和测试缺口
6. 输出结构化审查报告，包含结论、风险、测试建议和合并建议

## 使用资源

- 需要判断风险等级时，读取 `references/risk-rubric.md`
- 需要生成最终报告时，读取 `references/output-template.md`

## 风险等级

- P0：阻断合并，可能导致严重安全、数据或生产事故
- P1：高风险，必须修复或补充验证
- P2：中风险，建议修复或补充测试
- P3：低风险，优化建议

## 输出要求

- 只基于代码变更中的证据下结论
- 引用具体文件、函数、配置项或变更点
- 明确说明影响、建议动作和推荐测试
- 最后给出“可合并 / 补测后合并 / 不建议合并”的判断
