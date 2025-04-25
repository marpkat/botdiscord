require('dotenv').config();
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');

// Configurações
const REGIONS = ["ar-AE", "de-DE", "en-SG", "en-US", "es-ES", "es-MX", "fr-FR", "id-ID", "it-IT", "ja-JP", "ko-KR", "pl-PL", "pt-BR", "ru-RU", "th-TH", "tr-TR", "vi-VN", "zh-TW"]; // Regiões ajustadas
const API_BASE_URL = 'https://playvalorant.com/_next/data/UeyB4Rt7MNOkxHRINkUVu';
const CHECK_INTERVAL = 60 * 1000; // 1 minuto em milissegundos
const STATE_FILE = path.join(__dirname, 'news_state.json');

// Configurações do Discord
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

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
      if (!fetch) throw new Error('Fetch não está definido');
      const response = await fetch(`${API_BASE_URL}/${region}/news.json`, {
        headers: { 'User-Agent': 'ValorantNewsBot/1.0' },
      });
      if (!response.ok) throw new Error(`Erro HTTP: ${response.status}`);
      const data = await response.json();
      console.log(`Recebidos ${data.pageProps.posts?.length || 0} posts para ${region}`);
      return data.pageProps.posts || [];
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
    if (!state[region]) state[region] = [];

    for (const post of posts) {
      const contentId = post.analysis?.contentId;
      if (!contentId) continue;

      // Verifica se a notícia já foi vista
      if (!state[region].includes(contentId)) {
        // Cria um embed para a notificação
        const embed = new EmbedBuilder()
          .setTitle(`Nova Notícia em ${region.toUpperCase()}: ${post.title}`)
          .setDescription(post.description?.body || 'Sem descrição.')
          .setColor('#FF4655') // Cor temática do Valorant
          .setTimestamp(new Date(post.publishedAt))
          .setThumbnail(post.media?.url || null);

        if (post.action?.payload?.url) {
          const url = `https://playvalorant.com${post.action.payload.url}`;
          embed.setURL(url).addFields({ name: 'Link', value: `[Clique aqui](${url})` });
        }

        // Envia a notificação ao canal
        await channel.send({ embeds: [embed] });
        console.log(`Nova notícia em ${region}: ${post.title} (${post.publishedAt})`);
        state[region].push(contentId);
        hasNewNews = true;
      }
    }
  }

  // Salva o estado apenas se houver alterações
  if (hasNewNews) {
    await saveState(state);
  }
}

// Evento quando o bot está pronto
client.once('ready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  // Inicia a verificação imediatamente e a cada 1 minuto
  checkForNewNews().catch(console.error);
  setInterval(checkForNewNews, CHECK_INTERVAL);
});

// Conecta o bot ao Discord
client.login(DISCORD_TOKEN).catch((error) => {
  console.error('Erro ao conectar o bot:', error.message);
});

// Trata erros não capturados
process.on('unhandledRejection', (error) => {
  console.error('Erro não tratado:', error);
});
