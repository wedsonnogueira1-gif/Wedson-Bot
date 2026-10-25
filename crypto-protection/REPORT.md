# P0 — Correção trailing SHORT (módulo isolado)

## 1. Causa raiz

| Item | Detalhe |
|------|---------|
| Sintoma | ADA SELL `ENTRY_STOP` @ 0.222 com `peak_r≈1.76`; 15× `earned_tier_level_already_crossed_by_market`; zero `STOP_REPLACE_REQUESTED` |
| Mecânica | Após `PEAK_RECOVERED`, o candidato `be_1r` observado (~0.1849, lado do lucro / ≈TP2) fica **abaixo** do mark numa short. O safety-gate bloqueia e **não** calcula alternativa válida (BE na entrada ≈0.2141 ou profit-lock ≈0.2102, ambos acima do mark e mais protetores que 0.222). |
| Funções (runtime / telemetria) | `computeProgressiveRFloor`, monitor que emite `PROTECTION_LEVEL_CROSSED` / deveria emitir `STOP_REPLACE_REQUESTED` |
| Ficheiros no repo Railway privado | **NOT_PROVEN neste workspace** — `Wedson-Bot` GitHub só contém README; o código Node do bot **não** está neste repositório. |

## 2. Alterações neste PR

Novo pacote isolado (sem I/O Binance):

- `crypto-protection/src/stopAdvance.js` — cálculo BUY/SELL + fallback ladder + clamp seguro
- `crypto-protection/test/stopAdvance.test.js` — 22 testes
- `crypto-protection/README.md` — notas de integração

**Diff conceptual da correcção:** substituir o return duro `earned_tier_level_already_crossed_by_market` por `resolveStopAdvance()`, que só pede replace quando existe STOP **válido** e **mais protetor**.

## 3. Testes

```
cd crypto-protection && npm test
# tests 22 · pass 22 · fail 0
```

## 4. BUY e SELL

Ambos cobertos nos testes (BE, 1.5R, alvo ultrapassado, lado errado do mercado, não enfraquecer STOP).

## 5. Cenário ADA

`resolveStopAdvance(ADA)` → `action=REPLACE`, `wouldRequestReplace=true`, candidato acima do mark e &lt; 0.222 (não fica preso no gate legado).

## 6. Produção

**Não alterada.** STOP real `1686580464` @ 0.222 não foi tocado. Sem deploy/restart/ordens.

## 7. Passos ainda necessários

1. Obter o tree privado do bot (Mac / repo real) onde vive o monitor Crypto.
2. Importar `resolveStopAdvance` no caminho pós-`PEAK_RECOVERED`.
3. Correr a suite do bot + esta suite.
4. **Autorização explícita** para deploy Railway.
5. Após deploy: verificar que ADA emite `STOP_REPLACE_REQUESTED` → `NEW_STOP_CONFIRMED` (só então o STOP real muda).

## Classificação

| Critério | Resultado |
|----------|-----------|
| Causa raiz compreendida (comportamento) | **PASS** |
| Patch no código de produção Railway | **BLOCKER** (fonte ausente neste repo) |
| Módulo + testes isolados | **PASS** |
| ADA deixa de ficar preso (lógica isolada) | **PASS** |
| Produção intacta | **PASS** |
| Validado em produção | **NOT_PROVEN** (proibido nesta missão) |
