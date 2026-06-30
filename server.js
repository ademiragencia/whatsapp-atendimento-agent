import 'dotenv/config';
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Sua Empresa';
const DEFAULT_PROMPT = 'Atenda de forma cordial, objetiva e humana. Responda curto para WhatsApp. Faca uma pergunta por vez quando precisar de dados. Se o cliente pedir humano, atendente, cancelamento, reclamacao ou urgencia, encaminhe para atendimento humano. Nao invente precos, prazos, disponibilidade ou politicas.';
const DEFAULT_KNOWLEDGE = 'Edite KNOWLEDGE_BASE nas variaveis de ambiente com horarios, produtos, servicos, precos, politicas e perguntas frequentes da empresa.';

let behaviorPrompt = process.env.BEHAVIOR_PROMPT || DEFAULT_PROMPT;
const conversations = new Map();
const processedMessages = new Set();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendHtml(res, 200, renderHtml());
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'whatsapp-atendimento-agent' });
    }

    if (req.method === 'GET' && url.pathname === '/api/preview-status') {
      return sendJson(res, 200, getPreviewStatus());
    }

    if (req.method === 'GET' && url.pathname === '/api/behavior-prompt') {
      return sendJson(res, 200, { prompt: behaviorPrompt, defaultPrompt: DEFAULT_PROMPT, persisted: false });
    }

    if (req.method === 'POST' && url.pathname === '/api/behavior-prompt') {
      const body = await readJson(req);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { error: 'Prompt obrigatorio' });
      if (prompt.length > 8000) return sendJson(res, 400, { error: 'Prompt muito longo' });
      behaviorPrompt = prompt;
      return sendJson(res, 200, { ok: true, prompt: behaviorPrompt, persisted: false });
    }

    if (req.method === 'POST' && url.pathname === '/api/behavior-prompt/reset') {
      behaviorPrompt = DEFAULT_PROMPT;
      return sendJson(res, 200, { ok: true, prompt: behaviorPrompt, persisted: false });
    }

    if (req.method === 'POST' && url.pathname === '/api/preview-reset') {
      conversations.delete('preview');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/preview-chat') {
      const body = await readJson(req);
      const message = String(body.message || '').trim();
      if (!message) return sendJson(res, 400, { error: 'Mensagem obrigatoria' });
      const reply = await buildPreviewReply(message);
      return sendJson(res, 200, reply);
    }

    if (req.method === 'GET' && url.pathname === '/webhook') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN && challenge) {
        return sendText(res, 200, challenge);
      }
      return sendText(res, 403, 'Forbidden');
    }

    if (req.method === 'POST' && url.pathname === '/webhook') {
      const rawBody = await readRaw(req);
      if (!verifyMetaSignature(rawBody, req.headers['x-hub-signature-256'])) {
        return sendText(res, 401, 'Invalid signature');
      }
      const payload = JSON.parse(rawBody.toString('utf-8'));
      sendText(res, 200, 'EVENT_RECEIVED');
      processWebhookPayload(payload).catch((error) => console.error(error));
      return;
    }

    return sendText(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    return sendJson(res, error.statusCode || 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WhatsApp atendimento agent listening on port ${PORT}`);
});

async function buildPreviewReply(message) {
  const conversation = getConversation('preview');
  if (!isDeepSeekConfigured()) {
    const reply = `Modo demo ativo.\n\nRecebi: "${message}"\n\nQuando voce configurar DEEPSEEK_API_KEY no servidor, eu respondo usando a DeepSeek.`;
    appendTurn(conversation, 'user', message);
    appendTurn(conversation, 'assistant', reply);
    return { reply, mode: 'demo' };
  }
  const reply = await buildAgentReply(message, conversation, 'Cliente de teste');
  appendTurn(conversation, 'user', message);
  appendTurn(conversation, 'assistant', reply);
  return { reply, mode: 'deepseek' };
}

async function processWebhookPayload(payload) {
  const messages = extractIncomingMessages(payload);
  for (const message of messages) await processIncomingMessage(message);
}

async function processIncomingMessage(message) {
  if (processedMessages.has(message.id)) return;
  processedMessages.add(message.id);
  if (processedMessages.size > 1000) processedMessages.delete(processedMessages.values().next().value);

  if (!message.isTextual) {
    await sendWhatsAppText(message.from, 'Por enquanto eu entendo melhor mensagens de texto. Pode me enviar sua duvida escrita?');
    return;
  }

  const conversation = getConversation(message.from);
  const normalized = normalize(message.text);

  if (['/reset', 'reset', 'reiniciar', 'recomecar'].includes(normalized)) {
    conversations.delete(message.from);
    await sendWhatsAppText(message.from, 'Conversa reiniciada. Me diga como posso ajudar.');
    return;
  }

  if (['/bot', 'bot', 'voltar para bot', 'atendimento automatico'].includes(normalized)) {
    conversation.status = 'bot';
    await sendWhatsAppText(message.from, 'Pronto, voltei para o atendimento automatico. Como posso ajudar?');
    return;
  }

  if (shouldHandoff(message.text)) {
    conversation.status = 'human';
    appendTurn(conversation, 'user', message.text);
    const reply = 'Certo. Vou encaminhar voce para um atendente humano. Para agilizar, me envie seu nome e um resumo do que precisa.';
    appendTurn(conversation, 'assistant', reply);
    await sendWhatsAppText(message.from, reply);
    return;
  }

  if (conversation.status === 'human') {
    appendTurn(conversation, 'user', message.text);
    await sendWhatsAppText(message.from, 'Seu atendimento humano ja esta sinalizado. Um atendente vai seguir por aqui assim que possivel.');
    return;
  }

  try {
    const reply = await buildAgentReply(message.text, conversation, message.profileName || 'Cliente');
    appendTurn(conversation, 'user', message.text);
    appendTurn(conversation, 'assistant', reply);
    await sendWhatsAppText(message.from, reply);
  } catch (error) {
    console.error(error);
    await sendWhatsAppText(message.from, 'Tive uma instabilidade aqui. Pode tentar novamente em alguns instantes?');
  }
}

async function buildAgentReply(customerMessage, conversation, profileName) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('Missing DEEPSEEK_API_KEY');

  const systemPrompt = [
    `Voce e o agente de atendimento da empresa ${BUSINESS_NAME}.`,
    `Cliente: ${profileName || 'nao informado'}.`,
    '',
    'Prompt do atendimento:',
    behaviorPrompt,
    '',
    'Base de conhecimento:',
    process.env.KNOWLEDGE_BASE || DEFAULT_KNOWLEDGE,
    '',
    'Regras fixas: responda em pt-BR, curto, natural para WhatsApp, sem tabelas, sem pedir senhas/codigos/cartao completo/documentos sensiveis. Use apenas a base de conhecimento para fatos da empresa. Se nao souber, diga que vai confirmar.'
  ].join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversation.history.slice(-12).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: customerMessage }
  ];

  const response = await fetch(`${process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      messages,
      max_tokens: 650,
      thinking: { type: process.env.DEEPSEEK_THINKING || 'disabled' }
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`DeepSeek API error ${response.status}: ${JSON.stringify(body)}`);
  return cleanReply(body.choices?.[0]?.message?.content || 'Nao consegui gerar uma resposta agora.');
}

async function sendWhatsAppText(to, text) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error('Missing WhatsApp credentials');

  const url = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v25.0'}/${phoneNumberId}/messages`;
  const chunks = chunkText(text);
  for (const body of chunks) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body }
      })
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`WhatsApp API error ${response.status}: ${responseText}`);
  }
}

function extractIncomingMessages(payload) {
  const incoming = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      const names = new Map((value.contacts || []).map((contact) => [contact.wa_id, contact.profile?.name || '']));
      for (const message of value.messages || []) {
        const text = extractMessageText(message);
        incoming.push({
          id: message.id,
          from: message.from,
          type: message.type || 'unknown',
          text: text.body,
          isTextual: text.isTextual,
          profileName: names.get(message.from) || ''
        });
      }
    }
  }
  return incoming.filter((message) => message.id && message.from);
}

function extractMessageText(message) {
  if (message?.type === 'text') return { body: message.text?.body || '', isTextual: true };
  if (message?.type === 'button') return { body: message.button?.text || message.button?.payload || '', isTextual: true };
  if (message?.type === 'interactive') {
    const button = message.interactive?.button_reply;
    const list = message.interactive?.list_reply;
    return { body: button?.title || list?.title || '', isTextual: Boolean(button?.title || list?.title) };
  }
  return { body: '', isTextual: false };
}

function verifyMetaSignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  if (!signatureHeader || !String(signatureHeader).startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = String(signatureHeader).slice('sha256='.length);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(received, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function getConversation(id) {
  if (!conversations.has(id)) conversations.set(id, { status: 'bot', history: [] });
  return conversations.get(id);
}

function appendTurn(conversation, role, content) {
  conversation.history.push({ role, content, at: new Date().toISOString() });
  conversation.history = conversation.history.slice(-30);
}

function shouldHandoff(text) {
  const value = normalize(text);
  return ['humano', 'atendente', 'pessoa', 'falar com alguem', 'reclamacao', 'cancelar', 'urgente'].some((word) => value.includes(normalize(word)));
}

function normalize(text) {
  return String(text || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function cleanReply(text) {
  const cleaned = String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length <= 1200 ? cleaned : `${cleaned.slice(0, 1180).trim()}...\n\nPosso continuar se voce quiser.`;
}

function chunkText(text, maxLength = 3900) {
  const value = String(text || '').trim();
  if (!value) return [];
  const chunks = [];
  let remaining = value;
  while (remaining.length > maxLength) {
    let at = remaining.lastIndexOf('\n\n', maxLength);
    if (at < maxLength * 0.5) at = remaining.lastIndexOf(' ', maxLength);
    if (at < maxLength * 0.5) at = maxLength;
    chunks.push(remaining.slice(0, at).trim());
    remaining = remaining.slice(at).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function isDeepSeekConfigured() {
  return Boolean(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY !== 'coloque_sua_chave_deepseek_aqui');
}

function isWhatsAppConfigured() {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_VERIFY_TOKEN);
}

function getPreviewStatus() {
  return {
    deepseek: { configured: isDeepSeekConfigured(), label: isDeepSeekConfigured() ? `${process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'} conectado` : 'chave pendente' },
    whatsapp: { configured: isWhatsAppConfigured(), label: isWhatsAppConfigured() ? 'credenciais preenchidas' : 'credenciais pendentes' },
    prompt: { configured: true, label: 'memoria do servidor' }
  };
}

async function readJson(req) {
  const raw = await readRaw(req);
  try { return JSON.parse(raw.toString('utf-8') || '{}'); }
  catch { const error = new Error('Invalid JSON'); error.statusCode = 400; throw error; }
}

function readRaw(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('Payload too large');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function renderHtml() {
  return `<!doctype html>
<html lang='pt-BR'>
<head>
<meta charset='utf-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>Atendimento WhatsApp</title>
<style>
body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f4f1ea;color:#1f2a32}.app{min-height:100vh;display:grid;grid-template-columns:320px 1fr}.side{background:#10271f;color:#fff;padding:24px}.side h1{font-size:20px;margin:0 0 6px}.muted{color:#b8c9c0;font-size:13px}.status{border:1px solid #ffffff22;border-radius:8px;padding:12px;margin-top:12px;background:#ffffff0d}.status b{display:block;font-size:12px;color:#b8c9c0;text-transform:uppercase;margin-bottom:5px}.main{padding:24px;display:grid;grid-template-rows:auto 1fr auto;gap:14px}.tabs{display:flex;gap:8px}.tabs button,.small{border:1px solid #d8ded8;background:#fffdf8;border-radius:8px;padding:10px 14px;cursor:pointer}.tabs button.active{background:#13855d;color:white}.panel{border:1px solid #d8ded8;border-radius:8px;background:#fffdf8;box-shadow:0 20px 60px #1f2a3220;padding:18px;overflow:auto}.chat{display:grid;gap:12px;align-content:start}.bubble{max-width:760px;padding:11px 13px;border-radius:8px;white-space:pre-wrap;line-height:1.4}.agent{background:#dff5e9}.client{background:white;justify-self:end}.system{background:#fff2d2;color:#9a5b00;justify-self:center}.composer{display:grid;grid-template-columns:1fr 54px;gap:10px}.composer input,textarea{border:1px solid #d8ded8;border-radius:8px;padding:12px;font:inherit;background:#fffefa}textarea{width:100%;min-height:320px;box-sizing:border-box}.send,.primary{border:0;border-radius:8px;background:#13855d;color:white;cursor:pointer;padding:10px 16px}.hidden{display:none}@media(max-width:760px){.app{grid-template-columns:1fr}.main{padding:14px}}
</style>
</head>
<body>
<div class='app'>
<aside class='side'><h1>Atendimento WhatsApp</h1><div class='muted'>Preview local com DeepSeek</div><div id='status'></div></aside>
<main class='main'>
<div class='tabs'><button id='chatTab' class='active'>Chat</button><button id='promptTab'>Prompt</button><button id='reset' class='small'>Reset</button></div>
<section id='chatView' class='panel chat'><div id='messages'></div></section>
<section id='promptView' class='panel hidden'><p class='muted'>Edite como o agente deve atender. Em Render Free, para fixar permanente, coloque tambem em BEHAVIOR_PROMPT.</p><textarea id='prompt'></textarea><p><button id='savePrompt' class='primary'>Salvar prompt</button> <button id='restorePrompt' class='small'>Restaurar</button> <span id='promptMsg' class='muted'></span></p></section>
<form id='composer' class='composer'><input id='message' maxlength='900' placeholder='Mensagem'><button class='send'>➤</button></form>
</main>
</div>
<script>
const messages=document.querySelector('#messages'),statusBox=document.querySelector('#status'),message=document.querySelector('#message'),composer=document.querySelector('#composer'),promptEl=document.querySelector('#prompt'),promptMsg=document.querySelector('#promptMsg');
function add(role,text){const div=document.createElement('div');div.className='bubble '+role;div.textContent=text;messages.appendChild(div);document.querySelector('#chatView').scrollTop=999999;return div}
function show(name){document.querySelector('#chatView').classList.toggle('hidden',name!=='chat');document.querySelector('#promptView').classList.toggle('hidden',name!=='prompt');document.querySelector('#composer').classList.toggle('hidden',name!=='chat');document.querySelector('#chatTab').classList.toggle('active',name==='chat');document.querySelector('#promptTab').classList.toggle('active',name==='prompt')}
async function loadStatus(){const s=await fetch('/api/preview-status').then(r=>r.json());statusBox.innerHTML=Object.entries(s).map(([k,v])=>'<div class="status"><b>'+k+'</b>'+v.label+'</div>').join('');if(!s.deepseek.configured)add('system','DeepSeek ainda nao tem chave configurada. O preview esta em modo demo.')}
async function loadPrompt(){const p=await fetch('/api/behavior-prompt').then(r=>r.json());promptEl.value=p.prompt||p.defaultPrompt||'';promptMsg.textContent=p.persisted?'salvo':'temporario'}
composer.addEventListener('submit',async e=>{e.preventDefault();const text=message.value.trim();if(!text)return;message.value='';add('client',text);const typing=add('agent','Digitando...');try{const r=await fetch('/api/preview-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text})}).then(r=>r.json());typing.textContent=r.reply||'Sem resposta.'}catch{typing.textContent='Erro ao falar com servidor.'}});
document.querySelector('#chatTab').onclick=()=>show('chat');document.querySelector('#promptTab').onclick=()=>show('prompt');document.querySelector('#reset').onclick=async()=>{await fetch('/api/preview-reset',{method:'POST'});messages.textContent='';add('agent','Conversa reiniciada. Como posso ajudar?')};document.querySelector('#savePrompt').onclick=async()=>{const r=await fetch('/api/behavior-prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:promptEl.value})}).then(r=>r.json());promptMsg.textContent=r.ok?'salvo temporariamente':(r.error||'erro');add('system','Prompt do atendimento atualizado.')};document.querySelector('#restorePrompt').onclick=async()=>{const r=await fetch('/api/behavior-prompt/reset',{method:'POST'}).then(r=>r.json());promptEl.value=r.prompt;promptMsg.textContent='restaurado'};
Promise.all([loadStatus(),loadPrompt()]).then(()=>add('agent','Oi! Sou o atendimento automatico. Como posso ajudar?')).catch(()=>add('system','Nao consegui carregar o servidor.'));
</script>
</body>
</html>`;
}
