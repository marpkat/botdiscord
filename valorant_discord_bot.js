require('dotenv').config();
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Octokit } = require('@octokit/rest');
const express = require('express');

// Configurações
const REGIONS = ["ar-ae", "de-de", "en-us", "en-gb", "es-es"];
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

// Função para obter o buildId dinamicamente
async function getBuildId() {
  try {
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
    console.log('Tentando carregar estado do GitHub...');
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: GITHUB_PATH,
    });
    console.log('Estado carregado do GitHub com sucesso');
    return JSON.parse(Buffer.from(data.content, 'base64').toString());
  } catch (error) {
    console.error('Erro ao carregar estado do GitHub:', error.message, error.response?.data);
    return {};
  }
}

// Função para salvar o estado no GitHub
async function saveState(state) {
  try {
    console.log('Tentando buscar o arquivo news_state.json no GitHub...');
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: GITHUB_PATH,
    });
    console.log('Arquivo news_state.json encontrado no GitHub, atualizando...');
    console.log(`Estado a ser salvo: ${JSON.stringify(state, null, 2)}`);
    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: GITHUB_PATH,
      message: 'Atualiza estado do bot',
      content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'),
      sha: data.sha,
    });
    console.log('Estado salvo no GitHub com sucesso');
  } catch (error) {
    console.error('Erro ao salvar estado no GitHub:', error.message, error.response?.data);
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
  console.log(`Buscando notícias para ${region}...`); // Log ajustado para não exibir a URL
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
        console.log(`Resposta da API para ${region}: ${response.status} ${response.statusText}`);
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
      console.log(`Dados recebidos para ${region} com sucesso`);
      console.log(`Chaves em data para ${region}: ${Object.keys(data)}`);
      console.log(`Chaves em pageProps para ${region}: ${Object.keys(data.pageProps || {})}`);
      // Log para depurar a estrutura completa de pageProps.page
      if (data.pageProps?.page) {
        console.log(`Chaves em pageProps.page para ${region}: ${Object.keys(data.pageProps.page)}`);
        // Log adicional para verificar o conteúdo de pageProps.page.blades
        if (data.pageProps.page.blades) {
          console.log(`Conteúdo de pageProps.page.blades para ${region}: ${JSON.stringify(data.pageProps.page.blades, null, 2)}`);
        } else {
          console.log(`pageProps.page.blades não encontrado para ${region}`);
        }
      } else {
        console.log(`pageProps.page não encontrado para ${region}`);
      }
      let posts = [];
      if (data.pageProps?.blades) {
        const blades = data.pageProps.blades;
        console.log(`Blades encontrados em pageProps para ${region}: ${blades.length}`);
        if (blades.length > 0) {
          console.log(`Tipos de blades em pageProps para ${region}: ${blades.map(blade => blade.type).join(', ')}`);
        }
        const articleGrid = blades.find(blade => blade.type?.toLowerCase() === 'articlecardgrid') || {};
        console.log(`ArticleGrid encontrado em pageProps para ${region}: ${articleGrid.items ? articleGrid.items.length : 0} itens`);
        posts = articleGrid.items || [];
      } else if (data.pageProps?.articles) {
        console.log(`Tentando extrair posts de pageProps.articles para ${region}`);
        posts = data.pageProps.articles;
      } else if (data.pageProps?.content) {
        console.log(`Tentando extrair posts de pageProps.content para ${region}`);
        posts = data.pageProps.content;
      } else if (data.pageProps?.page?.blades) {
        const blades = data.pageProps.page.blades;
        console.log(`Blades encontrados em pageProps.page para ${region}: ${blades.length}`);
        if (blades.length > 0) {
          console.log(`Tipos de blades em pageProps.page para ${region}: ${blades.map(blade => blade.type).join(', ')}`);
        }
        const articleGrid = blades.find(blade => blade.type?.toLowerCase() === 'articlecardgrid') || {};
        console.log(`ArticleGrid encontrado em pageProps.page para ${region}: ${articleGrid.items ? articleGrid.items.length : 0} itens`);
        posts = articleGrid.items || [];
      } else {
        console.log(`Nenhuma chave com posts encontrada em pageProps ou pageProps.page para ${region}`);
      }
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
      console.log(`Primeiro post para ${region}: ${JSON.stringify(posts[0], null, 2)}`);
    } else {
      console.log(`Nenhum post retornado para ${region}`);
    }
    if (!state[region]) state[region] = [];

    for (const post of posts) {
      const contentId = post.analytics?.contentId || `${post.title}-${post.publishedAt}`;
      if (!contentId) {
        console.log(`Post sem identificador em ${region}: ${post.title}`);
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
          console.log(`hasNewNews definido como true após notificação de ${post.title}`);
        } catch (error) {
          console.error(`Erro ao enviar notificação para ${post.title} em ${region}:`, error.message);
        }
      } else {
        console.log(`Notícia já processada em ${region}: ${post.title} (${contentId})`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log(`hasNewNews final: ${hasNewNews}`);
  if (hasNewNews) {
    console.log('Novas notícias detectadas, salvando estado...');
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
