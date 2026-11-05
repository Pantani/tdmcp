---
description: "Gere bases musicais com um servidor local do ACE-Step 1.5 e use-as para conduzir visuais no TouchDesigner com o tdmcp."
---

# Geração de música com ACE-Step

O tdmcp pode gerar uma música ou base instrumental a partir de um prompt de texto e
construir um visual reativo sobre ela. O áudio vem do
[ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5), um modelo com licença MIT
que roda na sua própria máquina. O tdmcp conversa com o servidor de API dele e nunca
inclui o modelo no pacote.

Isso vem desligado por padrão. Sem `TDMCP_ACE_ENABLED`, nenhuma dessas ferramentas é registrada.

::: warning Planeje para pré-renderizar
O render do TD e o modelo disputam a mesma GPU. Gere a próxima base com antecedência
em vez de esperar uma jam ao vivo.
:::

## Configure

1. Instale o ACE-Step 1.5 e inicie o servidor de API. Os modelos são baixados no
   primeiro uso, então conte com cerca de 10 GB ([repositório do projeto](https://github.com/ace-step/ACE-Step-1.5)):

   ```bash
   git clone https://github.com/ace-step/ACE-Step-1.5.git
   ```

   ```bash
   cd ACE-Step-1.5 && uv sync && uv run acestep-api
   ```

   No Apple Silicon, use `./start_api_server_macos.sh`. Nos dois casos, o servidor
   escuta em `http://127.0.0.1:8001`.

2. Ative as ferramentas no ambiente do seu cliente MCP:

   ```bash
   export TDMCP_ACE_ENABLED=1
   export TDMCP_ACE_OUTPUT_DIR="$HOME/tdmcp-music"
   ```

   Use uma pasta de saída com caminho absoluto. O tdmcp baixa cada arquivo pronto
   para lá, e o TouchDesigner o abre a partir desse caminho.

3. Reinicie o cliente MCP e peça uma base:

   > Gere 30 segundos de techno pulsante a 128 bpm e depois construa um visual
   > reativo a partir dela.

## Ferramentas

| Ferramenta | O que faz |
|------------|-----------|
| `generate_music` | Gera uma base e retorna `wavPath`, `seconds` e `seed`, quando o servidor informa. Com `mode: "job"`, retorna um `job_id` na hora. |
| `generate_music_reactive` | Gera uma base e constrói uma rede reativa ao áudio sobre ela. |
| `submit_music_job` | Coloca uma geração na fila e retorna um `job_id`. |
| `get_music_job` | Informa o status de um job. A primeira consulta depois de pronto baixa o áudio. |

O prompt `song_to_show` guia uma IA para gerar uma música e construir um show inteiro
em torno dela. Na linha de comando, use `tdmcp-agent music generate`, `music reactive`,
`music submit` e `music job`.

### Parâmetros

| Parâmetro | Faixa | Padrão |
|-----------|-------|--------|
| `prompt` | Tags, gênero, clima | Obrigatório |
| `lyrics` | Texto com marcadores `[verse]`, `[chorus]` | Instrumental |
| `audio_duration` | 10 a 600 segundos | O modelo escolhe |
| `seed` | Inteiro maior ou igual a 0 | Aleatório |
| `inference_steps` | Modelos turbo de 1 a 20, modelos base de 1 a 200 | `TDMCP_ACE_DEFAULT_STEPS` |
| `guidance_scale` | Só modelos base | 7.0 |

## Configuração

| Variável | Padrão | Função |
|----------|--------|--------|
| `TDMCP_ACE_ENABLED` | desligado | Registra as ferramentas. |
| `TDMCP_ACE_HOST` / `TDMCP_ACE_PORT` | `127.0.0.1` / `8001` | Onde está o servidor. |
| `TDMCP_ACE_TOKEN` | nenhum | Precisa ser igual ao `ACESTEP_API_KEY` do servidor. |
| `TDMCP_ACE_OUTPUT_DIR` | `.tdmcp/ace-output` | Onde o áudio pronto é salvo. |
| `TDMCP_ACE_TIMEOUT_MS` | `600000` | Quanto tempo uma geração bloqueante espera. |
| `TDMCP_ACE_DEFAULT_STEPS` | `8` | Passos quando nenhum é pedido. Modelos base pedem de 32 a 64. |
| `TDMCP_ACE_POLL_MS` | `2000` | Com que frequência um job é consultado. |
| `TDMCP_ACE_RTF` | nenhum | Segundos de processamento por segundo de áudio na sua máquina. |
| `TDMCP_ACE_SYNC_MAX_SECONDS` | `120` | Estimativas maiores viram jobs quando `TDMCP_ACE_RTF` está definido. |

Para calibrar, rode um `generate_music` bloqueante, leia `observed_rtf` no resultado e
defina `TDMCP_ACE_RTF` com esse valor. Pedidos longos passam a retornar um `job_id` em
vez de bloquear.

## Limites

- **Jobs não podem ser cancelados.** O ACE-Step 1.5 não tem API de cancelamento. Se o
  cliente abortar ou o tempo limite passar, o tdmcp para de esperar, mas o servidor
  continua gerando. O erro informa o job, para você buscá-lo depois com `get_music_job`.
- **Jobs não sobrevivem a um reinício do servidor.** Consultar um depois disso informa job desconhecido.
- **O `seed` pode não vir no resultado.** O servidor nem sempre informa o seed que
  escolheu. Passe o seu quando precisar de um resultado repetível.
- **O progresso pode não estender o tempo limite do cliente.** O tdmcp envia notificações
  de progresso, mas reiniciar o tempo limite da chamada depende de cada cliente.

## Estado da verificação {#verification}

Os testes offline cobrem o cliente contra um mock do contrato do projeto. Estas
verificações precisam de um servidor real, e cada uma fica sem confirmação até ser executada.

| # | Verificação | Critério de aprovação |
|---|-------------|-----------------------|
| P-1 | `music generate --prompt "lofi hip hop" --audio_duration 10` | Retorna um WAV tocável na pasta de saída. |
| P-2 | O mesmo comando, duas vezes | A segunda execução não recarrega o modelo. |
| P-3 | `music submit` e depois `music job <job_id>` até terminar | O status vai de `running` para `done`, com um arquivo real. |
| P-4 | Leia `observed_rtf`, defina `TDMCP_ACE_RTF` e peça uma base longa | `mode: "auto"` retorna um `job_id`. |
| P-5 | `music reactive` com o bridge do TD ativo | Um CHOP Audio File In toca o WAV, e a rede processa sem erros. |
| P-6 | Uma geração longa num cliente MCP que mostra progresso | Anote se o cliente reinicia o tempo limite. |
