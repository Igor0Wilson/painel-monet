# 🚀 Financeiro Backend — NestJS API

Esta é a API robusta que alimenta o sistema de Controle Financeiro. Desenvolvida com **NestJS**, ela foca em segurança, escalabilidade e performance.

## 🛠️ Tecnologias
- **NestJS**: Framework Node.js progressivo.
- **Sequelize**: ORM para PostgreSQL.
- **Neon**: Banco de dados PostgreSQL serverless.
- **Passport + JWT**: Autenticação stateless segura.
- **Throttler**: Proteção contra ataques de força bruta e DoS.
- **Class Validator**: Validação rigorosa de dados de entrada.

## 📁 Estrutura de Pastas
- `src/auth`: Módulo de autenticação e estratégias JWT.
- `src/users`: Gestão de usuários e perfis.
- `src/expenses`: Lógica de despesas e parcelamentos.
- `src/income`: Gestão de receitas.
- `src/balance`: Cálculos de patrimônio e dados para gráficos.
- `scripts/`: Scripts SQL e utilitários de banco de dados.

## 🔐 Segurança Implementada
1. **Rate Limiting**: Limite global de 60 req/min e 5 req/min para login.
2. **Isolamento de Dados**: Filtro obrigatório por `userId` em todas as queries.
3. **Senhas Seguras**: Hash com **bcrypt (12 rounds)**.
4. **JWT Robusto**: Segredo de 96 caracteres e expiração configurável.
5. **CORS Dinâmico**: Permite apenas origens autorizadas via `FRONTEND_URL`.

## ⚙️ Como Rodar Localmente
1. Instale as dependências: `npm install`
2. Configure o `.env` (use o `.env.example` como base).
3. Inicie o servidor: `npm run start:dev`

## ☁️ Deploy (Render)
O projeto está pronto para o **Render** via Blueprint (`render.yaml`).
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm run start:prod`

---
Desenvolvido com foco em segurança e arquitetura limpa.
