/**
 * Figma MCP Wrapper Server
 * 
 * 既存のFigma MCPをプロキシしつつ、フロー情報を追加提供するMCPサーバー
 * 
 * アーキテクチャ:
 * 
 *   Cursor (AI)
 *       │
 *       ▼
 *   ┌─────────────────────────────────────┐
 *   │  Wrapper MCP Server (このサーバー)    │
 *   │                                     │
 *   │  ┌─────────────┐  ┌──────────────┐ │
 *   │  │ 独自ツール    │  │ プロキシ      │ │
 *   │  │ - get_flows │  │ → Figma MCP  │ │
 *   │  │ - get_full  │  │   (3845)     │ │
 *   │  │   _context  │  │              │ │
 *   │  └─────────────┘  └──────────────┘ │
 *   │         ▲                          │
 *   │         │                          │
 *   │  ┌──────┴──────┐                   │
 *   │  │ Flow Data   │ ← Figmaプラグイン  │
 *   │  │ Store       │   から受信        │
 *   │  └─────────────┘                   │
 *   └─────────────────────────────────────┘
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';

// 既存Figma MCPのURL
const FIGMA_MCP_URL = process.env.FIGMA_MCP_URL || 'http://127.0.0.1:3845/sse';

// フローデータのストア（プラグインから受信）
interface FlowDataStore {
  [key: string]: {
    data: any;
    receivedAt: string;
  };
}
const flowDataStore: FlowDataStore = {};
let latestFlowData: any = null;

// カスタムツールの定義
const CUSTOM_TOOLS: Tool[] = [
  {
    name: 'get_flows',
    description: 'Get prototype flow information (interactions, transitions, navigation) from Figma. This data is extracted from Figma plugin and includes trigger types, destination screens, and animation settings.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['json', 'markdown', 'mermaid'],
          description: 'Output format for the flow data',
          default: 'json',
        },
      },
    },
  },
  {
    name: 'get_full_context',
    description: 'Get comprehensive design context including both design metadata (from Figma MCP) and flow/interaction data. This combines get_design_context and get_flows for complete information.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'The ID of the node in the Figma document',
        },
        includeFlows: {
          type: 'boolean',
          description: 'Whether to include flow/interaction data',
          default: true,
        },
      },
    },
  },
  {
    name: 'list_flow_screens',
    description: 'List all screens/frames that have interactions defined',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// MCPサーバーのセットアップ
const server = new Server(
  {
    name: 'figma-flow-wrapper',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ツール一覧のハンドラ
server.setRequestHandler(ListToolsRequestSchema, async () => {
  // 既存Figma MCPからツール一覧を取得
  let figmaTools: Tool[] = [];
  
  try {
    const response = await fetch(FIGMA_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1,
      }),
    });
    
    const result = await response.json();
    if (result.result?.tools) {
      figmaTools = result.result.tools;
    }
  } catch (error) {
    console.error('Failed to fetch Figma MCP tools:', error);
  }
  
  // カスタムツールと既存ツールを結合
  return {
    tools: [...CUSTOM_TOOLS, ...figmaTools],
  };
});

// ツール実行のハンドラ
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  // カスタムツールの処理
  switch (name) {
    case 'get_flows':
      return handleGetFlows(args);
    
    case 'get_full_context':
      return handleGetFullContext(args);
    
    case 'list_flow_screens':
      return handleListFlowScreens();
    
    default:
      // 既存Figma MCPにプロキシ
      return proxyToFigmaMCP(name, args);
  }
});

// カスタムツール: get_flows
async function handleGetFlows(args: any) {
  if (!latestFlowData) {
    return {
      content: [
        {
          type: 'text',
          text: 'No flow data available. Please extract flow data from Figma using the Flow Extractor plugin first.',
        },
      ],
    };
  }
  
  const format = args?.format || 'json';
  let content: string;
  
  switch (format) {
    case 'markdown':
      content = flowDataToMarkdown(latestFlowData);
      break;
    case 'mermaid':
      content = flowDataToMermaid(latestFlowData);
      break;
    default:
      content = JSON.stringify(latestFlowData, null, 2);
  }
  
  return {
    content: [
      {
        type: 'text',
        text: content,
      },
    ],
  };
}

// カスタムツール: get_full_context
async function handleGetFullContext(args: any) {
  const results: string[] = [];
  
  // 1. 既存Figma MCPからデザインコンテキストを取得
  try {
    const designContext = await proxyToFigmaMCP('get_design_context', {
      nodeId: args?.nodeId,
    });
    results.push('## Design Context\n');
    results.push(JSON.stringify(designContext, null, 2));
  } catch (error) {
    results.push('## Design Context\nFailed to fetch design context');
  }
  
  // 2. フローデータを追加
  if (args?.includeFlows !== false && latestFlowData) {
    results.push('\n\n## Flow & Interactions\n');
    results.push(flowDataToMarkdown(latestFlowData));
  }
  
  return {
    content: [
      {
        type: 'text',
        text: results.join('\n'),
      },
    ],
  };
}

// カスタムツール: list_flow_screens
async function handleListFlowScreens() {
  if (!latestFlowData) {
    return {
      content: [
        {
          type: 'text',
          text: 'No flow data available.',
        },
      ],
    };
  }
  
  const screensWithInteractions = latestFlowData.screens
    .filter((s: any) => s.interactions && s.interactions.length > 0)
    .map((s: any) => ({
      id: s.id,
      name: s.name,
      interactionCount: s.interactions.length,
    }));
  
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(screensWithInteractions, null, 2),
      },
    ],
  };
}

// 既存Figma MCPへのプロキシ
async function proxyToFigmaMCP(toolName: string, args: any) {
  try {
    const response = await fetch(FIGMA_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: Date.now(),
      }),
    });
    
    const result = await response.json();
    
    if (result.error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error from Figma MCP: ${result.error.message}`,
          },
        ],
        isError: true,
      };
    }
    
    return result.result;
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Failed to proxy to Figma MCP: ${error}`,
        },
      ],
      isError: true,
    };
  }
}

// ユーティリティ: FlowDataをMarkdownに変換
function flowDataToMarkdown(data: any): string {
  let md = `# ${data.documentName} - ${data.pageName}\n\n`;
  md += `Extracted: ${data.extractedAt}\n\n`;
  
  if (data.flowConnections && data.flowConnections.length > 0) {
    md += `## Screen Transitions (${data.flowConnections.length})\n\n`;
    md += `| From | Trigger | Action | To | Transition |\n`;
    md += `|------|---------|--------|----|-----------|\n`;
    
    for (const conn of data.flowConnections) {
      md += `| ${conn.fromNodeName} | ${conn.trigger} | ${conn.actionType} | ${conn.toNodeName} | ${conn.transition || '-'} |\n`;
    }
  }
  
  return md;
}

// ユーティリティ: FlowDataをMermaidに変換
function flowDataToMermaid(data: any): string {
  if (!data.flowConnections || data.flowConnections.length === 0) {
    return 'flowchart TD\n  NoData[No interactions found]';
  }
  
  let mermaid = 'flowchart TD\n';
  const sanitizeId = (id: string) => id.replace(/[:-]/g, '_');
  const nodes = new Set<string>();
  
  for (const conn of data.flowConnections) {
    const fromId = sanitizeId(conn.fromNodeId);
    const toId = sanitizeId(conn.toNodeId);
    
    if (!nodes.has(fromId)) {
      mermaid += `  ${fromId}["${conn.fromNodeName}"]\n`;
      nodes.add(fromId);
    }
    if (!nodes.has(toId)) {
      mermaid += `  ${toId}["${conn.toNodeName}"]\n`;
      nodes.add(toId);
    }
  }
  
  mermaid += '\n';
  
  for (const conn of data.flowConnections) {
    const fromId = sanitizeId(conn.fromNodeId);
    const toId = sanitizeId(conn.toNodeId);
    mermaid += `  ${fromId} -->|${conn.trigger}| ${toId}\n`;
  }
  
  return mermaid;
}

// HTTPサーバー（プラグインからデータを受信するため）
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.post('/flow-data', (req, res) => {
  const data = req.body;
  const key = `${data.documentName}_${data.pageName}`;
  
  flowDataStore[key] = {
    data: data,
    receivedAt: new Date().toISOString(),
  };
  latestFlowData = data;
  
  console.log(`✅ Flow data received: ${key}`);
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// サーバー起動
async function main() {
  // HTTPサーバー起動（プラグインからのデータ受信用）
  const HTTP_PORT = process.env.HTTP_PORT || 3846;
  app.listen(HTTP_PORT, () => {
    console.log(`📡 HTTP server listening on port ${HTTP_PORT}`);
  });
  
  // MCPサーバー起動（stdio経由）
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('🚀 MCP Wrapper Server started');
}

main().catch(console.error);
