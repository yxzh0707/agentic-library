import type { OpenAIToolSpec } from '@kb/shared';
import type { PermissionTag, ToolContext } from '@kb/shared';
import { logger } from '../util/logger.js';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permission_tag: PermissionTag;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool) {
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(filter?: (tool: Tool) => boolean): Tool[] {
    const all = [...this.tools.values()];
    return filter ? all.filter(filter) : all;
  }

  visibleTo(permissions: PermissionTag[]): Tool[] {
    const set = new Set(permissions);
    return this.list((t) => set.has(t.permission_tag));
  }

  getOpenAISpec(permissions: PermissionTag[]): OpenAIToolSpec[] {
    return this.visibleTo(permissions).map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async invoke(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) return { error: `unknown tool: ${name}` };
    if (!ctx.permissions.includes(tool.permission_tag)) {
      return { error: `permission denied: ${tool.permission_tag} required` };
    }
    try {
      return await tool.handler(args, ctx);
    } catch (err) {
      logger.warn({ err, tool: name }, 'tool handler failed');
      return { error: (err as Error).message };
    }
  }
}
