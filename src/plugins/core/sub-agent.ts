import type { Plugin } from "../types.js";
import { createSubAgentTool } from "../../tools/sub_agent.js";

const DELEGATION_GUIDANCE = `## 子任务委派
- 对可独立进行的多方向调研、跨模块分析或代码审查，优先考虑使用 sub_agent_run 委派子任务；互不依赖的任务可通过 tasks 一次并行提交。
- 简单问题、少量文件读取或必须依赖上一步结果的任务直接完成，不要为了使用 sub-agent 而拆分，也不要重复执行已经委派的调研。
- 每个子任务需明确目标、范围、必要上下文和预期产出。子 agent 不会自动获得主会话的完整历史，需要的已知事实和文件路径应通过 context 传入。
- 子 agent 默认只读取、检索和分析；写文件、执行命令及最终决策由主 agent 负责。只能使用当前开放的工具，不能通过委派绕过权限审批。
- 收到结果后，主 agent 负责整合和核验关键结论，检查引用的文件或来源，明确不确定点；子任务失败或需要审批不等于完成，不要直接把未经核验的结论当作事实。`;

export const coreSubAgentPlugin: Plugin = {
  name: "core-sub-agent",
  async init(ctx) {
    ctx.registerTool(createSubAgentTool(ctx.workspacePath));
    ctx.registerHooks({
      onBuildTurnPrompt(hookCtx, prompt) {
        if (!hookCtx.getToolDefinitions().some(tool => tool.name === "sub_agent_run")) return;
        return `${prompt}\n\n${DELEGATION_GUIDANCE}`;
      },
    });
  },
};
