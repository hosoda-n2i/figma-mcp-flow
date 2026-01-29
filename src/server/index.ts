import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const PORT = process.env.PORT || 3846;

// CORS設定
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// フローデータを保存
interface FlowDataStore {
  [documentName: string]: {
    data: any;
    receivedAt: string;
  };
}

const flowDataStore: FlowDataStore = {};
let latestFlowData: any = null;

// HTTPエンドポイント

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// フローデータを受信（Figmaプラグインから）
app.post('/flow-data', (req, res) => {
  try {
    const data = req.body;
    const key = `${data.documentName}_${data.pageName}`;
    
    flowDataStore[key] = {
      data: data,
      receivedAt: new Date().toISOString(),
    };
    latestFlowData = data;
    
    console.log(`✅ Flow data received: ${key}`);
    console.log(`   - Screens: ${data.screens?.length || 0}`);
    console.log(`   - Connections: ${data.flowConnections?.length || 0}`);
    
    // WebSocketクライアントに通知
    broadcastToClients({
      type: 'flow-data-updated',
      key: key,
      summary: {
        screens: data.screens?.length || 0,
        connections: data.flowConnections?.length || 0,
      }
    });
    
    res.json({ success: true, key: key });
  } catch (error) {
    console.error('Error receiving flow data:', error);
    res.status(500).json({ error: 'Failed to process flow data' });
  }
});

// 最新のフローデータを取得
app.get('/flow-data/latest', (req, res) => {
  if (!latestFlowData) {
    res.status(404).json({ error: 'No flow data available' });
    return;
  }
  res.json(latestFlowData);
});

// 特定のドキュメントのフローデータを取得
app.get('/flow-data/:key', (req, res) => {
  const key = req.params.key;
  const stored = flowDataStore[key];
  
  if (!stored) {
    res.status(404).json({ error: 'Flow data not found' });
    return;
  }
  
  res.json(stored.data);
});

// 利用可能なフローデータ一覧
app.get('/flow-data', (req, res) => {
  const keys = Object.keys(flowDataStore).map(key => ({
    key: key,
    receivedAt: flowDataStore[key].receivedAt,
    screens: flowDataStore[key].data.screens?.length || 0,
    connections: flowDataStore[key].data.flowConnections?.length || 0,
  }));
  
  res.json(keys);
});

// MCP互換エンドポイント
app.get('/mcp', (req, res) => {
  res.json({
    name: 'figma-flow-extractor',
    version: '1.0.0',
    description: 'Extract and serve Figma prototype flow information',
    tools: [
      {
        name: 'get_flow_data',
        description: 'Get the latest extracted flow data from Figma',
        inputSchema: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['json', 'markdown', 'mermaid'],
              description: 'Output format'
            }
          }
        }
      },
      {
        name: 'list_flows',
        description: 'List all available flow data',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ]
  });
});

// MCPツール実行エンドポイント
app.post('/mcp/tools/:toolName', (req, res) => {
  const toolName = req.params.toolName;
  const args = req.body;
  
  switch (toolName) {
    case 'get_flow_data':
      if (!latestFlowData) {
        res.json({ error: 'No flow data available. Please extract flow data from Figma plugin first.' });
        return;
      }
      
      const format = args.format || 'json';
      
      if (format === 'json') {
        res.json(latestFlowData);
      } else if (format === 'markdown') {
        res.json({ content: flowDataToMarkdown(latestFlowData) });
      } else if (format === 'mermaid') {
        res.json({ content: flowDataToMermaid(latestFlowData) });
      }
      break;
      
    case 'list_flows':
      const keys = Object.keys(flowDataStore).map(key => ({
        key: key,
        receivedAt: flowDataStore[key].receivedAt,
        screens: flowDataStore[key].data.screens?.length || 0,
        connections: flowDataStore[key].data.flowConnections?.length || 0,
      }));
      res.json(keys);
      break;
      
    default:
      res.status(404).json({ error: `Unknown tool: ${toolName}` });
  }
});

// HTTPサーバー起動
const server = createServer(app);

// WebSocketサーバー
const wss = new WebSocketServer({ server, path: '/ws' });

const clients: Set<WebSocket> = new Set();

wss.on('connection', (ws) => {
  console.log('🔌 WebSocket client connected');
  clients.add(ws);
  
  // 接続時に最新データを送信
  if (latestFlowData) {
    ws.send(JSON.stringify({
      type: 'initial-data',
      data: latestFlowData
    }));
  }
  
  ws.on('close', () => {
    console.log('🔌 WebSocket client disconnected');
    clients.delete(ws);
  });
  
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      console.log('📨 WebSocket message:', msg.type);
      
      // メッセージ処理
      switch (msg.type) {
        case 'get-latest':
          ws.send(JSON.stringify({
            type: 'flow-data',
            data: latestFlowData
          }));
          break;
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
});

function broadcastToClients(message: any) {
  const messageStr = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

// ユーティリティ関数
function flowDataToMarkdown(data: any): string {
  let md = `# ${data.documentName} - ${data.pageName}\n\n`;
  md += `抽出日時: ${data.extractedAt}\n\n`;
  
  md += `## 画面一覧 (${data.screens.length}画面)\n\n`;
  
  for (const screen of data.screens) {
    if (screen.interactions.length > 0) {
      md += `### ${screen.name}\n`;
      md += `- ID: \`${screen.id}\`\n`;
      md += `- タイプ: ${screen.type}\n`;
      md += `- サイズ: ${screen.width} x ${screen.height}\n\n`;
      
      md += `#### インタラクション\n`;
      for (const interaction of screen.interactions) {
        md += `- **${interaction.nodeName}** (${interaction.nodeType})\n`;
        md += `  - トリガー: ${interaction.trigger.type}\n`;
        for (const action of interaction.actions) {
          md += `  - アクション: ${action.type}\n`;
          if (action.destinationName) {
            md += `    - 遷移先: ${action.destinationName}\n`;
          }
          if (action.transition) {
            md += `    - トランジション: ${action.transition.type} (${action.transition.duration}s)\n`;
          }
        }
      }
      md += `\n`;
    }
  }
  
  if (data.flowConnections.length > 0) {
    md += `## 画面遷移フロー\n\n`;
    md += `| 遷移元 | トリガー | アクション | 遷移先 | トランジション |\n`;
    md += `|--------|----------|------------|--------|----------------|\n`;
    
    for (const conn of data.flowConnections) {
      md += `| ${conn.fromNodeName} | ${conn.trigger} | ${conn.actionType} | ${conn.toNodeName} | ${conn.transition || '-'} |\n`;
    }
  }
  
  return md;
}

function flowDataToMermaid(data: any): string {
  if (!data || !data.flowConnections.length) {
    return 'flowchart TD\n  NoData[インタラクションが見つかりません]';
  }
  
  let mermaid = 'flowchart TD\n';
  
  const sanitizeId = (id: string) => id.replace(/[:-]/g, '_');
  
  const nodes = new Set<string>();
  data.flowConnections.forEach((conn: any) => {
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
  });
  
  mermaid += '\n';
  
  data.flowConnections.forEach((conn: any) => {
    const fromId = sanitizeId(conn.fromNodeId);
    const toId = sanitizeId(conn.toNodeId);
    const label = `${conn.trigger}`;
    mermaid += `  ${fromId} -->|${label}| ${toId}\n`;
  });
  
  return mermaid;
}

// サーバー起動
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 Figma Flow Extractor Server                         ║
║                                                           ║
║   HTTP:      http://localhost:${PORT}                      ║
║   WebSocket: ws://localhost:${PORT}/ws                     ║
║                                                           ║
║   Endpoints:                                              ║
║   - GET  /health          Health check                    ║
║   - GET  /flow-data       List all flow data              ║
║   - GET  /flow-data/latest  Get latest flow data          ║
║   - POST /flow-data       Receive flow data from plugin   ║
║   - GET  /mcp             MCP server info                 ║
║   - POST /mcp/tools/:name Execute MCP tool                ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
