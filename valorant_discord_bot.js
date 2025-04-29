require('dotenv').config();
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');

// Configurações
const REGIONS = ["ar-AE", "de-DE", "en-SG", "en-US", "en-gb", "es-ES", "es-MX", "fr-FR", "id-ID", "it-IT", "ja-JP", "ko-KR", "pl-PL", "pt-BR", "ru-RU", "th-TH", "tr-TR", "vi-VN", "zh-TW"];
const API_BASE_URL = 'https://playvalorant.com/_next/data/UeyB4Rt7MNOkxHRINkUVu';
const CHECK_INTERVAL = 3 * 60 * 1000; // 5 minutos em milissegundos (ajustado para evitar rate limits)
const STATE_FILE = path.join(__dirname, 'news_state.json');

// Configurações do Discord
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// Configurações do Express
const app = express();
const PORT = process.env.PORT || 3000;

// Inicia o servidor HTTP
app.get('/', (req, res) => {
  res.send('Bot do Valorant está rodando!');
});
app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

// Inicializa o cliente do Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Função para carregar o estado salvo
async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

// Função para salvar o estado
async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// Função para buscar notícias de uma região com retry
async function fetchNews(region, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${API_BASE_URL}/${region}/news.json`, {
        headers: { 'User-Agent': 'ValorantNewsBot/1.0' },
      });
      if (!response.ok) throw new Error(`Erro HTTP: ${response.status}`);
      const data = await response.json();

      // Encontrar o objeto com type: "articleCardGrid" em blades
      const articleGrid = (data.pageProps.blades || []).find(blade => blade.type === 'articleCardGrid');
      const posts = articleGrid ? articleGrid.items || [] : [];

      console.log(`Recebidos ${posts.length} posts para ${region}`);
      return posts;
    } catch (error) {
      console.error(`Tentativa ${attempt} falhou para ${region}: ${error.message}`);
      if (attempt === retries) {
        console.error(`Falha ao buscar notícias para ${region} após ${retries} tentativas`);
        return [];
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Função para verificar e notificar novas notícias
async function checkForNewNews() {
  console.log(`Verificando notícias às ${new Date().toISOString()}...`);
  const state = await loadState();
  let hasNewNews = false;

  const channel = client.channels.cache.get(CHANNEL_ID);
  if (!channel) {
    console.error('Canal não encontrado! Verifique o CHANNEL_ID.');
    return;
  }

  for (const region of REGIONS) {
    const posts = await fetchNews(region);
    console.log(`Processando ${posts.length} posts para ${region}`);
    if (posts.length > 0) {
      console.log(`Primeiro post: ${JSON.stringify(posts[0], null, 2)}`);
    }
    if (!state[region]) state[region] = [];

    for (const post of posts) {
      // Use analytics.contentId como identificador único
      const contentId = post.analytics?.contentId;
      if (!contentId) {
        console.log(`Post sem contentId: ${post.title}`);
        continue;
      }

      if (!state[region].includes(contentId)) {
        const embed = new EmbedBuilder()
          .setTitle(`Nova Notícia em ${region.toUpperCase()}: ${post.title}`)
          .setDescription(post.description?.body || 'Sem descrição.')
          .setColor('#FF4655')
          .setTimestamp(new Date(post.publishedAt))
          .setThumbnail(post.media?.url || null);

        if (post.action?.payload?.url) {
          // Ajuste para URLs externas (como YouTube) ou internas
          const url = post.action.payload.isExternal
            ? post.action.payload.url
            : `https://playvalorant.com${post.action.payload.url}`;
          embed.setURL(url).addFields({ name: 'Link', value: `[Clique aqui](${url})` });
        }

        await channel.send({ embeds: [embed] });
        console.log(`Nova notícia em ${region}: ${post.title} (${post.publishedAt})`);
        state[region].push(contentId);
        hasNewNews = true;
      } else {
        console.log(`Notícia já enviada em ${region}: ${post.title} (${contentId})`);
      }
    }
  }

  if (hasNewNews) {
    await saveState(state);
  }
}

// Função para enviar uma mensagem a cada 1 hora para manter o bot ativo
const KEEP_ALIVE_INTERVAL = 60 * 60 * 1000; // 1 hora em milissegundos

async function sendKeepAliveMessage() {
  const channel = client.channels.cache.get(CHANNEL_ID);
  if (!channel) {
    console.error('Canal não encontrado para mensagem keep-alive!');
    return;
  }

  try {
    await channel.send('✅ O bot está ativo!');
    console.log('Mensagem keep-alive enviada.');
  } catch (error) {
    console.error('Erro ao enviar mensagem keep-alive:', error.message);
  }
}

// Intervalo de 1 hora para manter o bot ativo
setInterval(sendKeepAliveMessage, KEEP_ALIVE_INTERVAL);

// Evento quando o bot está pronto
client.once('ready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  checkForNewNews().catch(console.error);
  setInterval(checkForNewNews, CHECK_INTERVAL);

  // Envia mensagem keep-alive para manter o bot ativo
  sendKeepAliveMessage().catch(console.error);
});

// Conecta o bot ao Discord
client.login(DISCORD_TOKEN).catch((error) => {
  console.error('Erro ao conectar o bot:', error.message);
});

// Trata erros não capturados
process.on('unhandledRejection', (error) => {
  console.error('Erro não tratado:', error);
});
