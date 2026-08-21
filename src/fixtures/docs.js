const docsPages = [
  {
    slug: 'quickstart',
    title: '快速开始',
    summary: '用兼容 OpenAI 的请求完成第一次 API 调用。',
    section: '开始使用',
    keywords: ['quickstart', 'curl', 'chat completions', '快速开始'],
    updated_at: null,
    blocks: [
      {
        type: 'lead',
        text: '本页使用 fixture 说明独立文档站的阅读体验。实际 API 域名、可用模型和账户权限要在接入 NewAPI 后由 live adapter 提供。',
      },
      {
        type: 'callout',
        tone: 'fixture',
        title: '当前不是 live NewAPI 文档',
        text: '示例保留可复制的请求结构，但不会把占位域名或 fixture 模型宣称为已经接通的生产能力。',
      },
      {
        type: 'heading',
        id: 'prepare',
        level: 2,
        text: '1. 准备环境变量',
      },
      {
        type: 'paragraph',
        text: '把控制台中实际显示的 API Base URL 和令牌写入本地环境。不要把令牌提交到代码仓库。',
      },
      {
        type: 'code',
        language: 'bash',
        label: 'Shell',
        code: 'export NEWAPI_BASE_URL="https://替换为你的实际-api-域名"\nexport NEWAPI_API_KEY="sk-替换为你的令牌"',
      },
      {
        type: 'heading',
        id: 'request',
        level: 2,
        text: '2. 发起请求',
      },
      {
        type: 'code',
        language: 'bash',
        label: 'cURL',
        code: 'curl "$NEWAPI_BASE_URL/v1/chat/completions" \\\n  -H "Authorization: Bearer $NEWAPI_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{\n    "model": "替换为控制台中的可用模型",\n    "messages": [\n      {"role": "user", "content": "你好，请用一句话介绍你自己。"}\n    ]\n  }\'',
      },
      {
        type: 'heading',
        id: 'next',
        level: 2,
        text: '3. 继续阅读',
      },
      {
        type: 'link-cards',
        items: [
          { slug: 'authentication', title: '认证', text: '安全地携带 API 令牌。' },
          { slug: 'chat-completions', title: '聊天补全', text: '理解请求与响应结构。' },
        ],
      },
    ],
  },
  {
    slug: 'authentication',
    title: '认证',
    summary: '使用 Bearer token 调用 API，并避免常见的令牌泄漏。',
    section: '开始使用',
    keywords: ['authentication', 'bearer', 'token', '认证', '令牌'],
    updated_at: null,
    blocks: [
      {
        type: 'lead',
        text: 'API 请求通过 Authorization 请求头携带 Bearer token。令牌代表账户权限，应当只保存在可信的服务端环境。',
      },
      {
        type: 'heading',
        id: 'header',
        level: 2,
        text: '请求头格式',
      },
      {
        type: 'code',
        language: 'http',
        label: 'HTTP',
        code: 'Authorization: Bearer $NEWAPI_API_KEY\nContent-Type: application/json',
      },
      {
        type: 'heading',
        id: 'security',
        level: 2,
        text: '安全建议',
      },
      {
        type: 'bullets',
        items: [
          '不要在浏览器前端、移动应用包或公开仓库中嵌入令牌。',
          '为不同应用创建独立令牌，并按实际需要限制额度与模型。',
          '怀疑泄漏时立即撤销旧令牌并轮换配置。',
        ],
      },
      {
        type: 'callout',
        tone: 'info',
        title: '服务端调用',
        text: '生产应用应由自己的后端保存令牌，再由后端向 NewAPI 发起请求。',
      },
    ],
  },
  {
    slug: 'chat-completions',
    title: '聊天补全',
    summary: '发送 messages 数组并处理兼容 OpenAI 的聊天补全响应。',
    section: 'API 指南',
    keywords: ['chat', 'completions', 'messages', 'stream', '聊天', '流式'],
    updated_at: null,
    blocks: [
      {
        type: 'lead',
        text: '聊天补全端点接受一组按顺序排列的 messages。模型可用性与具体参数以未来 live adapter 返回的公开能力为准。',
      },
      {
        type: 'endpoint',
        id: 'chat-completions-endpoint',
        method: 'POST',
        path: '/v1/chat/completions',
        text: '创建聊天补全',
      },
      {
        type: 'heading',
        id: 'body',
        level: 2,
        text: '请求体',
      },
      {
        type: 'table',
        columns: ['字段', '类型', '必填', '说明'],
        rows: [
          ['model', 'string', '是', '控制台中可用的模型名称。'],
          ['messages', 'array', '是', '按对话顺序排列的消息。'],
          ['stream', 'boolean', '否', '是否使用流式响应。'],
          ['temperature', 'number', '否', '模型支持时用于控制输出随机性。'],
        ],
      },
      {
        type: 'heading',
        id: 'json',
        level: 2,
        text: 'JSON 示例',
      },
      {
        type: 'code',
        language: 'json',
        label: 'JSON',
        code: '{\n  "model": "替换为控制台中的可用模型",\n  "messages": [\n    {"role": "system", "content": "你是一个简洁的助手。"},\n    {"role": "user", "content": "写一个三项检查清单。"}\n  ],\n  "stream": false\n}',
      },
    ],
  },
  {
    slug: 'responses',
    title: 'Responses API',
    summary: '了解统一响应端点的基础请求形状。',
    section: 'API 指南',
    keywords: ['responses', 'input', 'output', '响应'],
    updated_at: null,
    blocks: [
      {
        type: 'lead',
        text: '此 fixture 只展示文档信息架构，不代表当前部署已经开放 Responses API。接入 live adapter 后，应由 NewAPI 公开能力决定是否显示本页。',
      },
      {
        type: 'endpoint',
        id: 'responses-endpoint',
        method: 'POST',
        path: '/v1/responses',
        text: '创建模型响应',
      },
      {
        type: 'callout',
        tone: 'warning',
        title: '能力尚未验证',
        text: '不要仅凭页面或请求结构推断 provider、模型、工具调用或多模态能力已经可用。',
      },
      {
        type: 'heading',
        id: 'shape',
        level: 2,
        text: '基础结构',
      },
      {
        type: 'code',
        language: 'json',
        label: 'JSON',
        code: '{\n  "model": "替换为已验证的可用模型",\n  "input": "请总结这段文本。"\n}',
      },
    ],
  },
  {
    slug: 'errors',
    title: '错误处理',
    summary: '根据 HTTP 状态码、错误类型和 request id 诊断请求。',
    section: '参考',
    keywords: ['errors', '429', '401', 'request id', '错误'],
    updated_at: null,
    blocks: [
      {
        type: 'lead',
        text: '先判断 HTTP 状态，再记录公开错误字段和 request id。不要把令牌或完整敏感请求体写进日志。',
      },
      {
        type: 'heading',
        id: 'statuses',
        level: 2,
        text: '常见状态',
      },
      {
        type: 'table',
        columns: ['状态', '含义', '处理建议'],
        rows: [
          ['400', '请求格式或参数无效', '检查 JSON、模型和参数组合。'],
          ['401', '认证失败', '检查令牌是否存在、有效且未被撤销。'],
          ['429', '额度或速率受限', '检查账户额度，并使用带抖动的退避重试。'],
          ['5xx', '服务端或上游异常', '保留 request id，有限重试后再联系支持。'],
        ],
      },
      {
        type: 'heading',
        id: 'retry',
        level: 2,
        text: '重试边界',
      },
      {
        type: 'paragraph',
        text: '只对明确可重试且没有业务副作用的失败自动重试。流式请求或可能已创建任务的请求应先确认服务端状态。',
      },
    ],
  },
];

function docsBlockSearchText(block) {
  switch (block.type) {
    case 'lead':
    case 'paragraph':
      return block.text;
    case 'heading':
      return block.text;
    case 'callout':
      return `${block.title} ${block.text}`;
    case 'code':
      return `${block.label || ''} ${block.language || ''} ${block.code}`;
    case 'bullets':
      return block.items.join(' ');
    case 'endpoint':
      return `${block.method} ${block.path} ${block.text}`;
    case 'table':
      return [...block.columns, ...block.rows.flat()].join(' ');
    case 'link-cards':
      return block.items
        .map((item) => `${item.title} ${item.text} /docs/${item.slug}`)
        .join(' ');
    default:
      return '';
  }
}

function buildDocsSearchIndex(pages) {
  return pages.flatMap((page) => {
    const entries = new Map();
    const append = (anchor, targetTitle, text) => {
      const key = anchor || '';
      const current = entries.get(key) || {
        slug: page.slug,
        anchor: anchor || null,
        title: page.title,
        target_title: targetTitle || page.title,
        text: '',
      };
      current.text = `${current.text} ${text || ''}`.trim();
      entries.set(key, current);
    };

    append(null, page.title, [page.title, page.summary, ...(page.keywords || [])].join(' '));
    let currentHeading = null;
    page.blocks.forEach((block) => {
      if (block.type === 'heading') {
        currentHeading = { id: block.id, text: block.text };
      }
      const endpointAnchor = block.type === 'endpoint' ? block.id : null;
      append(
        endpointAnchor || currentHeading?.id || null,
        block.type === 'endpoint'
          ? `${block.method} ${block.path}`
          : currentHeading?.text || page.title,
        docsBlockSearchText(block),
      );
    });
    return [...entries.values()];
  });
}

export const docsFixture = Object.freeze({
  meta: {
    source: 'fixture',
    fixture: true,
    live: false,
    label: '演示文档数据',
    updated_at: null,
  },
  sections: ['开始使用', 'API 指南', '参考'].map((title) => ({
    title,
    items: docsPages
      .filter((page) => page.section === title)
      .map(({ slug, title: pageTitle, summary, keywords }) => ({
        slug,
        title: pageTitle,
        summary,
        keywords,
      })),
  })),
  search_index: buildDocsSearchIndex(docsPages),
  pages: docsPages,
});
