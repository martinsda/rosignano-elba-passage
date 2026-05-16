# rosignano-elba-passage

Briefing automatizado de travessia **Rosignano Solvay (Toscana) ↔ Portoferraio (Elba)** para um veleiro de 30 pés, gerado diariamente.

Modelado sobre o projecto [`maritime-weather`](../maritime-weather) (Lisboa → Cascais), com adaptações para o Mar Tirreno:

- Sem marés (Mediterrâneo — amplitude < 0,5 m)
- Dois pontos de previsão (origem e destino)
- Planeador de bordos heurístico baseado no rumo do vento vs rumo de travessia
- Janela semanal Go/No-Go por sentido

## O que gera

Cada execução produz:

1. `output/YYYY-MM-DD_rosignano-portoferraio-briefing.md` — relatório completo do dia
2. `index.html` — versão web (espelho do briefing mais recente)
3. Email opcional via SMTP

O briefing inclui:

- **Meteo de hoje** — tabela horária ECMWF IFS para Rosignano Solvay e Portoferraio
- **Plano de travessia para hoje** — se zarpar hoje em qualquer dos dois sentidos: vento médio, modo (bolina/través/largo/popa), ETA, plano de bordos
- **Previsão 7 dias** — Open-Meteo para ambos os pontos
- **Janela semanal Go/No-Go** — uma linha por dia, duas colunas (Sul e Norte)

## Como correr

Primeira vez (instalar dependências):

```bash
cd rosignano-elba-passage
npm install
node scripts/generate-briefing.js
```

Para **regenerar** o briefing com a previsão actual:

```bash
cd rosignano-elba-passage && node scripts/generate-briefing.js
```

Sem variáveis de ambiente o script usa apenas Open-Meteo (gratuito, sem chave). Para activar funcionalidades extra:

| Variável | Função |
|----------|--------|
| `WINDY_API_KEY` | Cross-check ICON-EU via Windy (opcional) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_TO` | Envio diário por email |

## Parâmetros da embarcação

Definidos em `data/waypoints.json` → `vessel`:

- Cruzeiro: 5,0 kt (través/largo)
- VMG bolina: 3,5 kt a TWA 45°
- **Limite Go**: ≤ 22 kt (F4) — tripulação mista, cruzeiro relaxado
- **Marginal**: 22–27 kt (F5)
- **No-Go**: > 27 kt (F6+), trovoadas (WMO 95/96/99), ou bolina cerrada sustentada em F5+

## Estrutura

```
rosignano-elba-passage/
├── scripts/generate-briefing.js   # gerador
├── data/waypoints.json             # coords, distância, rumos, perfil da embarcação
├── output/                         # briefings diários
├── docs/                           # documentos de referência (ventos, Elba, costa)
├── .github/workflows/              # GitHub Actions (cron diário 05:00 UTC)
└── index.html                      # página web
```

## Documentos de referência

- [`docs/01-ventos-mediterraneo-elba.md`](docs/01-ventos-mediterraneo-elba.md) — Mistral, Sirocco e como afectam a região de Elba
- [`docs/02-elba-historia-fundeadouros-turismo.md`](docs/02-elba-historia-fundeadouros-turismo.md) — história, fundeadouros e pontos turísticos
- [`docs/03-travessia-rosignano-portoferraio.md`](docs/03-travessia-rosignano-portoferraio.md) — descrição da costa entre os dois pontos

## Aviso

Instrumento de planeamento. **Não substitui** boletim oficial. Antes de zarpar verificar:

- Aeronautica Militare — [meteoam.it](https://meteoam.it)
- ARPAT Toscana — boletim marítimo
- VHF 16 / 68 (Capitanerie di Porto)
- Bandeiras locais e avisos no porto

## Licença

Uso pessoal. Sem garantias.
