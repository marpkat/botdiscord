import requests
import json
import re
from time import sleep

# Configurações
REGIONS = ["ar-ae", "de-de", "en-us", "en-gb", "es-es", "es-mx", "fr-fr", "id-id", "it-it", "ja-JP", "ko-KR", "pl-PL", "pt-BR", "ru-RU", "th-TH", "tr-TR", "vi-VN", "zh-TW"];
BASE_URL = "https://playvalorant.com"

# Cabeçalhos para simular uma requisição de navegador
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://playvalorant.com/",
    "Connection": "keep-alive",
    "Cache-Control": "no-cache",
    "Upgrade-Insecure-Requests": "1",
}

# Função para obter o buildId
def get_build_id():
    try:
        response = requests.get(f"{BASE_URL}/en-us/news/", headers=HEADERS)
        response.raise_for_status()
        text = response.text
        match = re.search(r'"buildId":"([^"]+)"', text)
        if match:
            build_id = match.group(1)
            print(f"BuildId encontrado: {build_id}")
            return build_id
        else:
            raise Exception("buildId não encontrado na página")
    except Exception as e:
        print(f"Erro ao obter buildId: {e}")
        return None

# Função para buscar notícias de uma região
def fetch_news(region, build_id, retries=3, delay=1):
    API_BASE_URL = f"{BASE_URL}/_next/data/{build_id}"
    url = f"{API_BASE_URL}/{region}/news.json"
    print(f"Buscando notícias para {region}...")
    
    for attempt in range(1, retries + 1):
        try:
            response = requests.get(url, headers=HEADERS)
            response.raise_for_status()
            data = response.json()
            print(f"Dados recebidos para {region} com sucesso")

            posts = []
            if "pageProps" in data and "page" in data["pageProps"] and "blades" in data["pageProps"]["page"]:
                blades = data["pageProps"]["page"]["blades"]
                print(f"Blades encontrados para {region}: {len(blades)}")
                article_grid = next((blade for blade in blades if blade.get("type", "").lower() == "articlecardgrid"), {})
                posts = article_grid.get("items", [])
                print(f"Posts filtrados para {region}: {len(posts)}")
            else:
                print(f"Nenhuma chave com posts encontrada para {region}")
            
            return posts
        except Exception as e:
            print(f"Tentativa {attempt} falhou para {region}: {e}")
            if attempt == retries:
                print(f"Falha ao buscar notícias para {region} após {retries} tentativas")
                return []
            sleep(delay)

# Função para gerar o news_state.json
def generate_news_state():
    # Obter o buildId
    build_id = get_build_id()
    if not build_id:
        print("Não foi possível obter o buildId. Abortando...")
        return

    # Dicionário para armazenar os contentIds por região
    state = {}

    # Buscar notícias para cada região
    for region in REGIONS:
        posts = fetch_news(region, build_id)
        if posts:
            # Extrair os contentIds dos posts
            content_ids = [post["analytics"]["contentId"] for post in posts if "analytics" in post and "contentId" in post["analytics"]]
            if content_ids:
                state[region] = content_ids
                print(f"contentIds para {region}: {content_ids}")
            else:
                print(f"Nenhum contentId encontrado para os posts de {region}")
        else:
            print(f"Nenhum post retornado para {region}")
        sleep(1)  # Pequeno delay para evitar sobrecarregar o servidor

    # Salvar o estado no arquivo news_state.json
    with open("news_state.json", "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    print("Arquivo news_state.json gerado com sucesso!")

# Executar o script
if __name__ == "__main__":
    generate_news_state()
