require('dotenv').config();
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const redis = require('redis');
const express = require('express');

// Configurações
const REGIONS = ["ar-AE", "de-DE", "en-SG", "en-US", "en-gb", "es-ES", "es-MX", "fr-FR", "id-ID", "it-IT", "ja-JP", "ko-KR", "pl-PL", "pt-BR", "ru-RU", "th-TH", "tr-TR", "vi-VN", "zh-TW"];
const API_BASE_URL = 'https://playvalorant.com/_next/data/UeyB4Rt7MNOkxHRINkUVu';
const CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutos (ajustado para evitar rate limits)
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// Configurações do Redis (Render Key Value)
const REDIS_URL = process.env.REDIS_URL || 'redis://red-d0b2j7muk2gs73casfag:6379'; // Usa variável de ambiente ou URL fornecida
const redisClient = redis.createClient({ url: REDIS_URL });

// Conectar ao Redis
redisClient.on('error', (err) => console.error('Erro no Redis:', err));
redisClient.connect().catch((err) => console.error('Erro ao conectar ao Redis:', err));

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

// Função para carregar o estado do Redis
async function loadState() {
  try {
    const data = await redisClient.get('news_state');
    console.log('Estado carregado do Redis:', data || '{}');
    return data ? JSON.parse(data) : {};
  } catch (error) {
    console.error('Erro ao carregar estado do Redis:', error.message);
    return {};
  }
}

// Função para salvar o estado no Redis
async function saveState(state) {
  try {
    await redisClient.set('news_state', JSON.stringify(state));
    console.log('Estado salvo no Redis');
  } catch (error) {
    console.error('Erro ao salvar estado no Redis:', error.message);
  }
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
      console.log(`Dados brutos para ${region}:`, JSON.stringify(data, null, 2));
      const articleGrid = (data.pageProps.blades || []).find(blade => blade.type === 'articleCardGrid');
      const posts = articleGrid ? articleGrid.items || [] : [];
      console.log(`Posts filtrados para ${region}: ${posts.length}`);
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
  if (!channel.permissionsFor(client.user).has('SendMessages')) {
    console.error('Bot não tem permissão para enviar mensagens no canal!');
    return;
  }

  for (const region of REGIONS) {
    const posts = await fetchNews(region);
    console.log(`Processando ${posts.length} posts para ${region}`);
    if (posts.length > 0) {
      console.log(`Primeiro post: ${JSON.stringify(posts[0], null, 2)}`);
    } else {
      console.log(`Nenhum post retornado para ${region}`);
    }
    if (!state[region]) state[region] = [];

    for (const post of posts) {
      const contentId = post.analytics?.contentId || `${post.title}-${post.publishedAt}`;
      if (!contentId) {
        console.log(`Post sem identificador: ${post.title}`);
        continue;
      }

      if (!state[region].includes(contentId)) {
        console.log(`Nova notícia detectada em ${region}: ${post.title} (${contentId})`);
        const embed = new EmbedBuilder()
          .setTitle(`Nova Notícia em ${region.toUpperCase()}: ${post.title}`)
          .setDescription(post.description?.body || 'Sem descrição.')
          .setColor('#FF4655')
          .setTimestamp(new Date(post.publishedAt))
          .setThumbnail(post.media?.url || null);

        if (post.action?.payload?.url) {
          const url = post.action.payload.isExternal
            ? post.action.payload.url
            : `https://playvalorant.com${post.action.payload.url}`;
          embed.setURL(url).addFields({ name: 'Link', value: `[Clique aqui](${url})` });
        }

        try {
          await channel.send({ embeds: [embed] });
          console.log(`Notificação enviada para ${post.title} em ${region}`);
          state[region].push(contentId);
          hasNewNews = true;
        } catch (error) {
          console.error(`Erro ao enviar notificação para ${post.title}:`, error.message);
        }
      } else {
        console.log(`Notícia já processada em ${region}: ${post.title} (${contentId})`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (hasNewNews) {
    await saveState(state);
    console.log('Estado atualizado com novas notícias');
  } else {
    console.log('Nenhuma nova notícia detectada.');
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

// Encerrar conexão com Redis ao desligar o bot
process.on('SIGTERM', async () => {
  await redisClient.quit();
  console.log('Conexão com Redis encerrada');
  process.exit(0);
});
