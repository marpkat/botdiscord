require('dotenv').config();
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Octokit } = require('@octokit/rest');
const express = require('express');

// Configurações
const REGIONS = ["ar-AE", "de-DE", "en-SG", "en-US", "en-gb", "es-ES", "es-MX", "fr-FR", "id-ID", "it-IT", "ja-JP", "ko-KR", "pl-PL", "pt-BR", "ru-RU", "th-TH", "tr-TR", "vi-VN", "zh-TW"];
const BASE_URL = 'https://playvalorant.com';
const CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutos
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Configurações do GitHub
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const GITHUB_OWNER = 'marpkat';
const GITHUB_REPO = 'botdiscord';
const GITHUB_PATH = 'news_state.json';

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

// Variável para armazenar o buildId
let apiBuildId = null;

// Função para obter o buildId dinamicamente
async function getBuildId() {
  try {
    const response = await fetch(`${BASE_URL}/pt-br/news/`, {
      headers: { 'User-Agent': 'ValorantNewsBot/1.0' },
    });
    const text = await response.text();
    const match = text.match(/"buildId":"([^"]+)"/);
    if (match && match[1]) {
      apiBuildId = match[1];
      console.log(`Novo buildId encontrado: ${apiBuildId}`);
    } else {
      throw new Error('buildId não encontrado na página');
    }
  } catch (error) {
    console.error('Erro ao obter buildId:', error.message);
    apiBuildId = null;
  }
}

// Função para carregar o estado do GitHub
async function loadState() {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: GITHUB_PATH,
    });
    console.log('Estado carregado do GitHub:', data.content);
    return JSON.parse(Buffer.from(data.content, 'base64').toString());
  } catch (error) {
    console.error('Erro ao carregar estado do GitHub:', error.message);
    return {};
  }
}

// Função para salvar o estado no GitHub
async function saveState(state) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: GITHUB_PATH,
    });
    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: GITHUB_PATH,
      message: 'Atualiza estado do bot',
      content: Buffer.from(JSON.stringify(state)).toString('base64'),
      sha: data.sha,
    });
    console.log('Estado salvo no GitHub');
  } catch (error) {
    console.error('Erro ao salvar estado no GitHub:', error.message);
  }
}

// Função para buscar notícias de uma região com retry
async function fetchNews(region, retries = 3, delay = 1000) {
  if (!apiBuildId) {
    console.log('buildId não disponível, buscando...');
    await getBuildId();
  }
  if (!apiBuildId) {
    console.error('Não foi possível obter o buildId. Abortando busca de notícias.');
    return [];
  }
  const API_BASE_URL = `${BASE_URL}/_next/data/${apiBuildId}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${API_BASE_URL}/${region}/news.json`, {
        headers: { 'User-Agent': 'ValorantNewsBot/1.0' },
      });
      if (!response.ok) {
        if (response.status === 404 && attempt === 1) {
          console.log('Erro 404 detectado, tentando atualizar buildId...');
          await getBuildId();
          if (apiBuildId) {
            return await fetchNews(region, retries, delay); // Tenta novamente com novo buildId
          }
        }
        throw new Error(`Erro HTTP: ${response.status}`);
      }
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
const KEEP_ALIVE_INTERVAL = 60 * 60 * 1000; // 1 hora

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
client.once('ready', async () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  const channel = client.channels.cache.get(CHANNEL_ID);
  channel.send('Teste manual de notificação').catch(console.error); // Teste inicial
  await getBuildId(); // Busca o buildId ao iniciar
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
