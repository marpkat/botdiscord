require('dotenv').config();
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Octokit } = require('@octokit/rest');
const express = require('express');

// Configurações
const REGIONS = ["ar-ae", "de-de", "en-us", "en-gb", "es-es", "es-mx", "fr-fr", "id-id", "it-it", "ja-jp", "ko-kr", "pl-pl", "pt-br", "ru-ru", "th-th", "tr-tr", "vi-vn", "zh-tw"];
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
const PORT = process.env.PORT || 10000;

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

// Variável para evitar múltiplas execuções simultâneas de checkForNewNews
let isCheckingNews = false;

// Função para obter o buildId dinamicamente
async function getBuildId() {
  try {
    console.log('Obtendo buildId...');
    const response = await fetch(`${BASE_URL}/en-us/news/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://playvalorant.com/',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
      },
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
    console.log('Carregando estado do GitHub...');
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: GITHUB_PATH,
    });
    const state = JSON.parse(Buffer.from(data.content, 'base64').toString());
    console.log('Estado carregado com sucesso.');
    return state;
  } catch (error) {
    console.error('Erro ao carregar estado do GitHub:', error.message, error.response?.data);
    throw new Error('Falha ao carregar o news_state.json. Verifique o GITHUB_TOKEN e o formato do arquivo.');
  }
}

// Função para salvar o estado no GitHub
async function saveState(state) {
  try {
    console.log('Salvando estado no GitHub...');
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
      content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'),
      sha: data.sha,
    });
    console.log('Estado salvo com sucesso.');
  } catch (error) {
    console.error('Erro ao salvar estado no GitHub:', error.message, error.response?.data);
    throw new Error('Falha ao salvar o news_state.json. Verifique o GITHUB_TOKEN e o acesso ao repositório.');
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
  const url = `${API_BASE_URL}/${region}/news.json`;
  console.log(`Buscando notícias para ${region}...`);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': 'https://playvalorant.com/en-us/news/',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
          'Upgrade-Insecure-Requests': '1',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      });
      if (!response.ok) {
        console.log(`Falha na API para ${region}: ${response.status} ${response.statusText}`);
        if (response.status === 404 && attempt === 1) {
          console.log('Erro 404 detectado, tentando atualizar buildId...');
          await getBuildId();
          if (apiBuildId) {
            return await fetchNews(region, retries, delay);
          }
        }
        console.warn(`Falha ao buscar notícias para ${region}: ${response.status}`);
        return [];
      }
      const data = await response.json();
      let posts = [];
      if (data.pageProps?.blades) {
        const articleGrid = data.pageProps.blades.find(blade => blade.type?.toLowerCase() === 'articlecardgrid') || {};
        posts = articleGrid.items || [];
      } else if (data.pageProps?.articles) {
        posts = data.pageProps.articles;
      } else if (data.pageProps?.content) {
        posts = data.pageProps.content;
      } else if (data.pageProps?.page?.blades) {
        const articleGrid = data.pageProps.page.blades.find(blade => blade.type?.toLowerCase() === 'articlecardgrid') || {};
        posts = articleGrid.items || [];
      }
      console.log(`Encontrados ${posts.length} posts para ${region}.`);
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
  if (isCheckingNews) {
    console.log('Verificação de notícias já em andamento. Aguardando próximo ciclo...');
    return;
  }

  isCheckingNews = true;
  console.log(`Verificando notícias às ${new Date().toISOString()}...`);

  try {
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
      if (!state[region]) {
        console.log(`Nenhum estado existente para ${region}, inicializando...`);
        state[region] = [];
      }

      for (const post of posts) {
        let contentId = post.analytics?.contentId;
        if (!contentId) {
          console.warn(`Post sem contentId em ${region}: ${post.title}. Usando fallback.`);
          contentId = `${post.title}-${post.publishedAt}`;
        }

        if (!state[region].includes(contentId)) {
          console.log(`Nova notícia detectada em ${region}: ${post.title}`);
          const embed = new EmbedBuilder()
            .setTitle(`Nova Notícia em ${region.toUpperCase()}: ${post.title}`)
            .setDescription(post.description?.body || 'Sem descrição.')
            .setColor('#FF4655')
            .setTimestamp(new Date(post.publishedAt))
            .setThumbnail(post.media?.url || null);

          if (post.action?.payload?.url) {
            const url = post.action.payload.url.startsWith('http')
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
            console.error(`Erro ao enviar notificação para ${post.title} em ${region}:`, error.message);
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (hasNewNews) {
      console.log('Novas notícias detectadas, salvando estado...');
      await saveState(state);
      console.log('Estado atualizado com novas notícias.');
    } else {
      console.log('Nenhuma nova notícia detectada.');
    }
  } catch (error) {
    console.error('Erro em checkForNewNews:', error.message);
  } finally {
    isCheckingNews = false;
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
let intervalId = null;
client.once('ready', async () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  const channel = client.channels.cache.get(CHANNEL_ID);
  if (channel) {
    channel.send('Teste manual de notificação').catch(console.error);
  } else {
    console.error('Canal não encontrado ao iniciar o bot!');
  }
  await getBuildId();
  await checkForNewNews();
  if (!intervalId) {
    intervalId = setInterval(checkForNewNews, CHECK_INTERVAL);
    console.log(`Intervalo de verificação configurado: ${CHECK_INTERVAL}ms`);
  }
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
