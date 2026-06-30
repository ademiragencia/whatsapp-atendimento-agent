# WhatsApp Atendimento Agent

Agente de atendimento para WhatsApp Business Cloud API usando DeepSeek.

Este repositorio esta pronto para subir em um host Node.js como Render. GitHub Pages sozinho nao serve para este agente, porque o WhatsApp precisa chamar um webhook `POST` com backend e as chaves precisam ficar no servidor.

## O que vem pronto

- Preview HTML em `/`
- Health check em `/health`
- Webhook Meta WhatsApp em `/webhook`
- Chat local de teste em `/api/preview-chat`
- Editor de prompt em `/api/behavior-prompt`
- Integracao DeepSeek Chat Completions
- Envio de resposta pela WhatsApp Cloud API
- Handoff simples quando o cliente pede humano/atendente

## Variaveis de ambiente

Configure no Render ou no seu host:

```text
DEEPSEEK_API_KEY=sua_chave_deepseek
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_THINKING=disabled

GRAPH_API_VERSION=v25.0
WHATSAPP_ACCESS_TOKEN=seu_token_da_meta
WHATSAPP_PHONE_NUMBER_ID=seu_phone_number_id
WHATSAPP_VERIFY_TOKEN=um_token_que_voce_inventa
META_APP_SECRET=opcional_mas_recomendado

BUSINESS_NAME=Sua Empresa
BEHAVIOR_PROMPT=como o agente deve atender
KNOWLEDGE_BASE=informacoes da empresa produtos horarios politicas
```

## Rodar local

```powershell
npm install
Copy-Item .env.example .env
npm start
```

Abra:

```text
http://localhost:3000/
```

## Deploy no Render

1. Acesse https://render.com
2. Crie **New Web Service**
3. Conecte este repositorio GitHub
4. Use:

```text
Build Command: npm install
Start Command: npm start
Plan: Free
```

5. Configure as variaveis de ambiente acima.
6. Depois do deploy, teste:

```text
https://SEU-SERVICO.onrender.com/health
```

## Configurar na Meta

No painel Meta Developers:

```text
WhatsApp > Configuration
```

Use:

```text
Callback URL: https://SEU-SERVICO.onrender.com/webhook
Verify token: o mesmo valor de WHATSAPP_VERIFY_TOKEN
```

Depois assine o campo:

```text
messages
```

## Fontes oficiais

- Meta WhatsApp Business Platform: https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started
- Meta Webhooks: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
- DeepSeek API: https://api-docs.deepseek.com/
- DeepSeek Chat Completions: https://api-docs.deepseek.com/api/create-chat-completion
