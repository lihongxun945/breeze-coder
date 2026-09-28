import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as model from "../../src/model/index.js";
import { AgentSession } from "../../src/agent.js";
import { createDefaultConfig } from "../../src/config.js";
import { PluginManager } from "../../src/plugin-manager.js";
import { runSubAgents } from "../../src/sub-agent.js";
import type { Config, SessionContext } from "../../src/types.js";
import { FakeModelClient } from "../helpers/fake-model-client.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

const projectTools = ["project_tree", "project_search", "git_status", "git_diff"];
const workspaces: string[] = [];

function workspace(subAgent?: Config["subAgent"]): string {
  const path = createTempWorkspace({
    subAgent,
    autoMemory: { enabled: false },
    memory: { enabled: false },
  });
  workspaces.push(path);
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of workspaces.splice(0)) removeTempWorkspace(path);
});

describe("sub-agent delegation", () => {
  it.each([false, true])("injects guidance with custom prompt=%s but not when delegation is filtered", async custom => {
    const path = workspace();
    if (custom) writeFileSync(resolve(path, "system_prompt.md"), "Custom system prompt");
    for (const disabled of [false, true]) {
      const manager = new PluginManager(path, { disabledTools: disabled ? ["sub_agent_run"] : [] });
      try {
        await manager.loadCorePlugins();
        const client = new FakeModelClient([{ text: "done", toolCalls: [] }]);
        const session = new AgentSession(`main-${disabled}`, path, manager, {}, client);
        for await (const _event of session.chat("检查项目")) { /* drain */ }
        const prompt = client.calls[0].systemPrompt!;
        expect(prompt.includes("## 子任务委派")).toBe(!disabled);
        if (custom) expect(prompt).toContain("Custom system prompt");
        if (!disabled) {
          expect(prompt).toContain("简单问题");
          expect(prompt).toContain("主 agent 负责整合和核验关键结论");
        }
      } finally { await manager.destroy(); }
    }
  });

  it.each(["absent", "empty", "initialized"] as const)("opens read-only project tools using %s defaults", async defaults => {
    const config = defaults === "initialized"
      ? createDefaultConfig().subAgent as Config["subAgent"]
      : defaults === "empty" ? { allowedTools: [] } : undefined;
    const path = workspace(config);
    const sessionContext: SessionContext = { mode: "project", project: { root: path, name: "test" } };
    const client = new FakeModelClient([
      { text: "", toolCalls: [{ type: "tool_use", id: "tree", name: "project_tree", input: {} }] },
      { text: "已检查项目目录", toolCalls: [] },
    ]);
    vi.spyOn(model, "createModelClientFromProfile").mockReturnValue(client);
    const result = await runSubAgents({ workspacePath: path, sessionContext, tasks: [{ task: "检查目录" }] });
    expect(result.results[0]).toMatchObject({ status: "completed", summary: "已检查项目目录" });
    expect(result.results[0].toolCalls).toContainEqual({ name: "project_tree", input: {} });
    const toolResults = client.calls[1].messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === "tool_result") : []);
    expect(toolResults).toContainEqual(expect.objectContaining({
      tool_use_id: "tree",
      content: expect.stringContaining('"path":"config.json"'),
    }));
    const names = client.calls[0].tools!.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([...projectTools, "memory_search"]));
    for (const name of ["sub_agent_run", "bash", "file_write", "file_edit", "memory_save", "memory_delete"]) {
      expect(names).not.toContain(name);
    }
    expect(client.calls[0].systemPrompt).not.toContain("## 子任务委派");
  });

  it("hides project tools in chat sessions", async () => {
    const path = workspace();
    const client = new FakeModelClient([{ text: "done", toolCalls: [] }]);
    vi.spyOn(model, "createModelClientFromProfile").mockReturnValue(client);
    await runSubAgents({ workspacePath: path, tasks: [{ task: "调研" }] });
    const names = client.calls[0].tools!.map(tool => tool.name);
    for (const name of projectTools) expect(names).not.toContain(name);
    expect(names).toContain("file_read");
  });

  it("preserves explicit allow/deny lists and always prevents recursive delegation", async () => {
    const path = workspace({ allowedTools: ["file_read", "project_search", "sub_agent_run"], disabledTools: ["project_search"] });
    const client = new FakeModelClient([{ text: "done", toolCalls: [] }]);
    vi.spyOn(model, "createModelClientFromProfile").mockReturnValue(client);
    await runSubAgents({
      workspacePath: path,
      sessionContext: { mode: "project", project: { root: path, name: "test" } },
      tasks: [{ task: "调研" }],
    });
    expect(client.calls[0].tools!.map(tool => tool.name)).toEqual(["file_read"]);
  });
});
