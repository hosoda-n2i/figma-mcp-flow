// Figma Flow Extractor Plugin
// プロトタイプのインタラクション情報を抽出するプラグイン

interface FlowInteraction {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  trigger: {
    type: string;
    delay?: number;
  };
  actions: FlowAction[];
}

interface FlowAction {
  type: string;
  destinationId?: string;
  destinationName?: string;
  navigation?: string;
  transition?: {
    type: string;
    duration: number;
    easing: {
      type: string;
      easingFunctionCubicBezier?: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
      };
    };
  };
  overlay?: {
    position: string;
    offsetX?: number;
    offsetY?: number;
  };
}

interface FlowScreen {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  interactions: FlowInteraction[];
  children?: FlowScreen[];
}

interface FlowData {
  documentName: string;
  pageName: string;
  extractedAt: string;
  screens: FlowScreen[];
  flowConnections: FlowConnection[];
}

interface FlowConnection {
  fromNodeId: string;
  fromNodeName: string;
  toNodeId: string;
  toNodeName: string;
  trigger: string;
  actionType: string;
  transition?: string;
}

// トリガータイプを文字列に変換
function getTriggerTypeString(trigger: Trigger): string {
  const triggerType = trigger.type;
  
  if (triggerType === 'ON_CLICK') return 'クリック';
  if (triggerType === 'ON_HOVER') return 'ホバー';
  if (triggerType === 'ON_PRESS') return 'プレス';
  if (triggerType === 'ON_DRAG') return 'ドラッグ';
  if (triggerType === 'AFTER_TIMEOUT') {
    const timeout = (trigger as any).timeout;
    return `${timeout || 0}ms後`;
  }
  if (triggerType === 'MOUSE_ENTER') return 'マウスエンター';
  if (triggerType === 'MOUSE_LEAVE') return 'マウスリーブ';
  if (triggerType === 'MOUSE_UP') return 'マウスアップ';
  if (triggerType === 'MOUSE_DOWN') return 'マウスダウン';
  if (triggerType === 'ON_KEY_DOWN') return 'キー押下';
  
  return triggerType;
}

// アクションタイプを文字列に変換
function getActionTypeString(action: Action): string {
  const actionType = action.type;
  
  if (actionType === 'BACK') return '戻る';
  if (actionType === 'CLOSE') return '閉じる';
  if (actionType === 'URL') return 'URL開く';
  if (actionType === 'SET_VARIABLE') return '変数設定';
  if (actionType === 'SET_VARIABLE_MODE') return '変数モード設定';
  if (actionType === 'CONDITIONAL') return '条件分岐';
  if (actionType === 'UPDATE_MEDIA_RUNTIME') return 'メディア更新';
  
  if (actionType === 'NODE') {
    // NODEアクションの場合、navigationプロパティで詳細を判定
    const navigation = (action as any).navigation as string | undefined;
    if (navigation === 'NAVIGATE') return '画面遷移';
    if (navigation === 'SWAP') return 'スワップ';
    if (navigation === 'OVERLAY') return 'オーバーレイ表示';
    if (navigation === 'SCROLL_TO') return 'スクロール';
    if (navigation === 'CHANGE_TO') return '変更';
    return 'ノードアクション';
  }
  
  return actionType;
}

// トランジション情報を抽出
function extractTransition(action: Action): FlowAction['transition'] | undefined {
  if (action.type === 'NODE' && action.transition) {
    const transition = action.transition;
    return {
      type: transition.type,
      duration: transition.duration,
      easing: {
        type: transition.easing.type,
        easingFunctionCubicBezier: transition.easing.type === 'CUSTOM_CUBIC_BEZIER' 
          ? transition.easing.easingFunctionCubicBezier 
          : undefined
      }
    };
  }
  return undefined;
}

// ノードからインタラクション情報を抽出
function extractInteractions(node: SceneNode): FlowInteraction[] {
  const interactions: FlowInteraction[] = [];
  
  if ('reactions' in node && node.reactions && node.reactions.length > 0) {
    for (const reaction of node.reactions) {
      const trigger = reaction.trigger;
      if (!trigger) continue;
      
      const actions = reaction.actions || [];
      
      const flowActions: FlowAction[] = [];
      
      for (const action of actions) {
        const flowAction: FlowAction = {
          type: getActionTypeString(action),
        };
        
        // 遷移先の情報を取得
        if (action.type === 'NODE' && action.destinationId) {
          flowAction.destinationId = action.destinationId;
          const destNode = figma.getNodeById(action.destinationId);
          flowAction.destinationName = destNode?.name || 'Unknown';
          flowAction.navigation = action.navigation;
          flowAction.transition = extractTransition(action);
        }
        
        // オーバーレイの場合
        if (action.type === 'NODE' && action.navigation === 'OVERLAY') {
          const overlayPos = action.overlayRelativePosition;
          flowAction.overlay = {
            position: typeof overlayPos === 'string' ? overlayPos : 'CENTER',
          };
        }
        
        // URLアクション
        if (action.type === 'URL') {
          flowAction.destinationName = action.url;
        }
        
        flowActions.push(flowAction);
      }
      
      // トリガーの遅延時間を取得
      let delay: number | undefined = undefined;
      if (trigger.type === 'AFTER_TIMEOUT' && 'timeout' in trigger) {
        delay = (trigger as any).timeout;
      }
      
      interactions.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        trigger: {
          type: getTriggerTypeString(trigger),
          delay: delay,
        },
        actions: flowActions,
      });
    }
  }
  
  return interactions;
}

// ノードを再帰的に走査してインタラクションを収集
function traverseNode(node: SceneNode, screens: FlowScreen[], connections: FlowConnection[]): void {
  const interactions = extractInteractions(node);
  
  // インタラクションがある場合、接続情報を追加
  for (const interaction of interactions) {
    for (const action of interaction.actions) {
      if (action.destinationId) {
        connections.push({
          fromNodeId: node.id,
          fromNodeName: node.name,
          toNodeId: action.destinationId,
          toNodeName: action.destinationName || 'Unknown',
          trigger: interaction.trigger.type,
          actionType: action.type,
          transition: action.transition?.type,
        });
      }
    }
  }
  
  // フレームやコンポーネントの場合、画面として追加
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    const screen: FlowScreen = {
      id: node.id,
      name: node.name,
      type: node.type,
      width: node.width,
      height: node.height,
      interactions: interactions,
      children: [],
    };
    screens.push(screen);
  }
  
  // 子ノードを走査
  if ('children' in node) {
    for (const child of node.children) {
      traverseNode(child, screens, connections);
    }
  }
}

// ページ全体のフロー情報を抽出
async function extractFlowData(): Promise<FlowData> {
  const page = figma.currentPage;
  const screens: FlowScreen[] = [];
  const connections: FlowConnection[] = [];
  
  for (const child of page.children) {
    traverseNode(child, screens, connections);
  }
  
  return {
    documentName: figma.root.name,
    pageName: page.name,
    extractedAt: new Date().toISOString(),
    screens: screens,
    flowConnections: connections,
  };
}

// 選択されたノードのフロー情報を抽出
async function extractSelectedFlowData(): Promise<FlowData> {
  const selection = figma.currentPage.selection;
  const screens: FlowScreen[] = [];
  const connections: FlowConnection[] = [];
  
  if (selection.length === 0) {
    // 選択がない場合はページ全体を抽出
    return extractFlowData();
  }
  
  for (const node of selection) {
    traverseNode(node, screens, connections);
  }
  
  return {
    documentName: figma.root.name,
    pageName: figma.currentPage.name,
    extractedAt: new Date().toISOString(),
    screens: screens,
    flowConnections: connections,
  };
}

// フローデータをMarkdown形式に変換
function flowDataToMarkdown(data: FlowData): string {
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

// UIを表示
figma.showUI(__html__, { width: 500, height: 600 });

// UIからのメッセージを処理
figma.ui.onmessage = async (msg: { type: string; data?: any }) => {
  switch (msg.type) {
    case 'extract-all':
      try {
        const data = await extractFlowData();
        const markdown = flowDataToMarkdown(data);
        figma.ui.postMessage({ type: 'flow-data', data, markdown });
      } catch (error) {
        figma.ui.postMessage({ type: 'error', message: String(error) });
      }
      break;
      
    case 'extract-selection':
      try {
        const data = await extractSelectedFlowData();
        const markdown = flowDataToMarkdown(data);
        figma.ui.postMessage({ type: 'flow-data', data, markdown });
      } catch (error) {
        figma.ui.postMessage({ type: 'error', message: String(error) });
      }
      break;
      
    case 'send-to-server':
      // ローカルサーバーにデータを送信
      figma.ui.postMessage({ type: 'send-data', data: msg.data });
      break;
      
    case 'close':
      figma.closePlugin();
      break;
  }
};

// 選択変更時に通知
figma.on('selectionchange', () => {
  const selection = figma.currentPage.selection;
  figma.ui.postMessage({ 
    type: 'selection-changed', 
    count: selection.length,
    names: selection.map(n => n.name)
  });
});
