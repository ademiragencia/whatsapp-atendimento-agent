# Deploy no Render

Este agente precisa de backend Node.js. GitHub Pages nao roda webhook `POST`, entao use GitHub + Render.

## 1. Criar Web Service

1. Acesse https://render.com
2. Clique em **New +**
3. Escolha **Web Service**
4. Conecte o GitHub
5. Escolha o repo `ademiragencia/whatsapp-atendimento-agent`
6. Configure:

```text
Build Command: npm install
Start Command: npm start
Plan: Free
```

## 2. Environment Variables

No Render, va em **Environment** e adicione:

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
BEHAVIOR_PROMPT=Atenda de forma cordial, objetiva e humana.
KNOWLEDGE_BASE=Coloque aqui horarios, produtos, servicos, precos e politicas.
```

## 3. Testar

Depois do deploy, abra:

```text
https://SEU-SERVICO.onrender.com/health
```

Se responder `ok`, use esta URL no WhatsApp:

```text
https://SEU-SERVICO.onrender.com/webhook
```

## 4. Meta WhatsApp

No Meta Developers:

```text
WhatsApp > Configuration
```

Use:

```text
Callback URL: https://SEU-SERVICO.onrender.com/webhook
Verify token: igual ao WHATSAPP_VERIFY_TOKEN
```

Depois assine o campo `messages`.
