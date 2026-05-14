# CodeFlow Guard

CodeFlow Guard 是一个面向合并前代码审查的 CodeBuddy Skill。它先用脚本稳定采集 Git 与仓库事实，再引导 LLM 根据风险规则生成结构化审查报告，输出风险等级、测试建议和合并建议。

本项目适用于真实研发团队的代码评审、发布前检查、安全合规巡检和质量门禁。

## 核心能力

- 自动采集 Git 状态、diff、待审查文件、行号锚点、当前文件快照、语法检查结果、测试结果和疑似风险信号。
- 识别认证绕过、硬编码凭据、敏感日志、订单/支付计算风险、JSON 解析异常、debug 绕过和跳过关键测试。
- 输出中文结构化报告，包括 P0-P3 风险等级、Top 3 必须修复项、变更摘要、关键风险、测试建议、合并前检查清单和复审标准。
- 支持当前变更审查、指定路径审查和 `diff=0` 静态巡检。
- 以脚本事实数据为权威来源，同时保留 LLM 对风险等级和合并建议的判断能力。

## 目录结构

```text
.skills/
  codeflow-guard/
    SKILL.md
    scripts/
      collect-review-context.js
      language-adapters.js
    references/
      output-template.md
      risk-rubric.md
examples/
  demo-project/            # JavaScript / Node.js 风险样例
  go-checkout-service/     # Go 风险样例
  python-order-service/    # Python 风险样例
```

`.skills/codeflow-guard` 是可安装的 Skill 本体。`examples` 是用于比赛演示和边界验证的测试样例，不属于生产业务代码。

## 设计思路

CodeFlow Guard 的核心设计是“脚本采集事实 + LLM 判断风险”：

- 脚本负责采集事实：文件列表、diff 数量、行号、测试状态、跳过测试总数、敏感信号等。
- LLM 负责审查判断：P0/P1/P2/P3 风险等级、风险归并、修复优先级和合并建议。

如果最终报告中的数量、状态、路径或行号与脚本输出冲突，必须重新核查并以脚本事实为准。

## 快速使用

在仓库根目录运行：

```bash
node .skills/codeflow-guard/scripts/collect-review-context.js --repo .
```

指定审查范围：

```bash
node .skills/codeflow-guard/scripts/collect-review-context.js --repo . --path examples/python-order-service
```

传入测试命令：

```bash
node .skills/codeflow-guard/scripts/collect-review-context.js --repo . --test-cmd "npm test"
```

推荐在 CodeBuddy 中这样触发：

```text
请使用 codeflow-guard 审查当前仓库变更，并给出风险等级、测试建议和合并建议。
```

## 示例覆盖

项目内置 JS、Go、Python 三组风险样例，用于验证 Skill 的多语言审查能力。

| 风险边界 | JavaScript | Go | Python |
| --- | --- | --- | --- |
| 认证绕过 | 支持 | 支持 | 支持 |
| 硬编码 token / API key | 支持 | 支持 | 支持 |
| 敏感 header / body 日志 | 支持 | 支持 | 支持 |
| 跳过关键测试 | 支持 | 支持 | 支持 |
| 负数数量 / 校验绕过 | 支持 | 支持 | 支持 |
| 折扣 / 优惠券上限风险 | 支持 | 支持 | 支持 |
| JSON 解析 / 请求处理风险 | 支持 | 支持 | 支持 |

这些 examples 故意包含高风险代码和跳过测试，仅用于测试与演示。

## 报告结构

最终报告遵循 `references/output-template.md`，必须包含：

1. 结论
2. 审查上下文
3. Top 3 必须修复项
4. 变更摘要
5. 关键风险
6. 测试建议
7. 合并前检查清单
8. 复审标准

关键约束：

- 使用中文输出。
- 引用仓库相对路径。
- 敏感值必须脱敏，禁止输出完整 token、密码、API key 或连接串。
- 区分“静态扫描发现跳过测试总数”和“本次需处理的跳过测试”。
- `Git diff 变更文件数 = 0` 只表示当前没有 diff 改动，不代表没有审查内容。

## 比赛亮点

- **场景价值**：面向真实研发流程中的合并前风险审查和质量门禁。
- **效率提升**：把分散的 diff、文件、测试和风险信号整理成可执行审查报告。
- **功能完整性**：覆盖证据采集、风险分级、测试建议、合并建议和复审标准。
- **创新与深度**：通过脚本事实权威、多语言样例、敏感信息脱敏和 diff-free 语义提升审查可靠性。

## 提交材料

- Skill 本体：`.skills/codeflow-guard`
- 多语言样例：`examples`
- 作品说明文档：`CodeFlow_Guard_Submission_Document.docx`
