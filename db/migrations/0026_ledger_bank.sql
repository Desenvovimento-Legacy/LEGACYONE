-- 0026 — One Ledger (partidas dobradas) e extrato bancário.
--
-- Garantias no próprio banco, não só no código:
--   * débito = crédito em cada lançamento (verificado no fim da transação);
--   * lançamento com pelo menos duas linhas, todas gravadas na mesma transação;
--   * conta analítica, da mesma empresa e vigente na data do lançamento;
--   * período bloqueado não recebe lançamento;
--   * nada é alterado nem apagado: correção é estorno (lançamento inverso).

-- ------------------------------------------------------------------ plano de contas
CREATE TABLE chart_account (
  id               uuid NOT NULL PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  entity_id        uuid NOT NULL,
  code             text NOT NULL CHECK (code ~ '^[0-9]+(\.[0-9]+)*$'),
  name             text NOT NULL,
  nature           text NOT NULL CHECK (nature IN ('ATIVO', 'PASSIVO', 'PATRIMONIO_LIQUIDO', 'RECEITA', 'CUSTO', 'DESPESA')),
  analytic         boolean NOT NULL,
  parent_code      text,
  referential_code text,
  valid_from       date NOT NULL,
  valid_to         date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  source           text NOT NULL CHECK (source IN ('PADRAO_LEGACY', 'MIGRACAO', 'MANUAL', 'BANCO')),
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, entity_id WITH =, code WITH =, daterange(valid_from, valid_to, '[]') WITH &&),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX chart_account_code_ix ON chart_account (tenant_id, entity_id, code);
SELECT apply_tenant_rls('chart_account');

-- ------------------------------------------------------------------ bloqueio de período
CREATE TABLE ledger_period_lock (
  id          uuid NOT NULL PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  entity_id   uuid NOT NULL,
  competence  date NOT NULL CHECK (extract(day FROM competence) = 1),
  status      text NOT NULL CHECK (status IN ('BLOQUEADO', 'REABERTO')),
  reason      text NOT NULL,
  actor_id    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX ledger_period_lock_ix ON ledger_period_lock (tenant_id, entity_id, competence, created_at DESC);
SELECT apply_tenant_rls('ledger_period_lock');

-- ------------------------------------------------------------------ lançamentos
CREATE TABLE journal_entry (
  id               uuid NOT NULL PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  entity_id        uuid NOT NULL,
  competence       date NOT NULL CHECK (extract(day FROM competence) = 1),
  entry_date       date NOT NULL CHECK (date_trunc('month', entry_date)::date = competence),
  history          text NOT NULL CHECK (length(history) > 0),
  origin           text NOT NULL CHECK (origin IN ('BANCO', 'FISCAL', 'FOLHA', 'TRIBUTOS', 'MIGRACAO', 'MANUAL', 'ESTORNO')),
  origin_ref       text,
  rule_ref         text,
  actor_kind       text NOT NULL,
  actor_id         text NOT NULL,
  confidence       numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence         jsonb NOT NULL DEFAULT '[]',
  reverses_id      uuid,
  idempotency_key  text NOT NULL,
  tx_id            bigint NOT NULL DEFAULT txid_current(),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((origin = 'ESTORNO') = (reverses_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_id) REFERENCES journal_entry (tenant_id, id)
);
CREATE UNIQUE INDEX journal_entry_one_reversal ON journal_entry (tenant_id, reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX journal_entry_comp_ix ON journal_entry (tenant_id, entity_id, competence);
CREATE INDEX journal_entry_origin_ix ON journal_entry (tenant_id, origin, origin_ref);
SELECT apply_tenant_rls('journal_entry');

CREATE TABLE journal_line (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  entry_id     uuid NOT NULL,
  seq          int NOT NULL CHECK (seq > 0),
  account_id   uuid NOT NULL,
  debit        numeric(15,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit       numeric(15,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  history      text,
  cost_center  text,
  dimensions   jsonb NOT NULL DEFAULT '{}',
  tx_id        bigint NOT NULL DEFAULT txid_current(),
  CHECK ((debit > 0) <> (credit > 0)),
  UNIQUE (tenant_id, entry_id, seq),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entry (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES chart_account (tenant_id, id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX journal_line_account_ix ON journal_line (tenant_id, account_id);
CREATE INDEX journal_line_entry_ix ON journal_line (tenant_id, entry_id);
SELECT apply_tenant_rls('journal_line');

-- Período bloqueado não recebe lançamento.
CREATE OR REPLACE FUNCTION journal_entry_check_period() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT l.status INTO st FROM ledger_period_lock l
   WHERE l.tenant_id = NEW.tenant_id AND l.entity_id = NEW.entity_id AND l.competence = NEW.competence
   ORDER BY l.created_at DESC LIMIT 1;
  IF st = 'BLOQUEADO' THEN
    RAISE EXCEPTION 'Período % bloqueado: reabra antes de lançar', to_char(NEW.competence, 'MM/YYYY') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entry_period BEFORE INSERT ON journal_entry FOR EACH ROW EXECUTE FUNCTION journal_entry_check_period();

-- Linha: mesma transação do lançamento, mesma empresa, conta analítica vigente na data.
CREATE OR REPLACE FUNCTION journal_line_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE e journal_entry; a chart_account;
BEGIN
  SELECT * INTO e FROM journal_entry WHERE tenant_id = NEW.tenant_id AND id = NEW.entry_id;
  IF e.tx_id <> NEW.tx_id THEN
    RAISE EXCEPTION 'Lançamento já gravado não recebe linha nova: faça estorno e novo lançamento' USING ERRCODE = 'check_violation';
  END IF;
  IF e.entity_id <> NEW.entity_id THEN
    RAISE EXCEPTION 'Linha de outra empresa' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO a FROM chart_account WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id;
  IF a.entity_id <> NEW.entity_id THEN
    RAISE EXCEPTION 'Conta % não é do plano desta empresa', a.code USING ERRCODE = 'check_violation';
  END IF;
  IF NOT a.analytic THEN
    RAISE EXCEPTION 'Conta % é sintética: lance em conta analítica', a.code USING ERRCODE = 'check_violation';
  END IF;
  IF e.entry_date < a.valid_from OR (a.valid_to IS NOT NULL AND e.entry_date > a.valid_to) THEN
    RAISE EXCEPTION 'Conta % não vigente em %', a.code, to_char(e.entry_date, 'DD/MM/YYYY') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_line_check BEFORE INSERT ON journal_line FOR EACH ROW EXECUTE FUNCTION journal_line_check();

-- Débito = crédito e pelo menos duas linhas, conferido no fim da transação.
CREATE OR REPLACE FUNCTION journal_entry_check_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric; n int;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO d, c, n
    FROM journal_line WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id;
  IF n < 2 THEN
    RAISE EXCEPTION 'Lançamento sem as duas partidas (% linha)', n USING ERRCODE = 'check_violation';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'Débitos (%) diferentes dos créditos (%)', d, c USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entry_balance AFTER INSERT ON journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_check_balance();

-- Imutável.
CREATE OR REPLACE FUNCTION ledger_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Lançamento contábil não se altera nem se apaga: use estorno' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER journal_entry_immutable BEFORE UPDATE OR DELETE ON journal_entry FOR EACH ROW EXECUTE FUNCTION ledger_block_changes();
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON journal_line FOR EACH ROW EXECUTE FUNCTION ledger_block_changes();

-- ------------------------------------------------------------------ banco
CREATE TABLE bank_account (
  id                 uuid NOT NULL PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  entity_id          uuid NOT NULL,
  bank_code          text NOT NULL,
  branch             text NOT NULL DEFAULT '',
  number             text NOT NULL,
  label              text NOT NULL,
  ledger_account_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity_id, bank_code, branch, number),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_account_id) REFERENCES chart_account (tenant_id, id)
);
SELECT apply_tenant_rls('bank_account');

CREATE TABLE bank_statement_file (
  id               uuid NOT NULL PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  entity_id        uuid NOT NULL,
  bank_account_id  uuid NOT NULL,
  format           text NOT NULL CHECK (format IN ('OFX', 'CSV')),
  file_name        text NOT NULL,
  content          bytea NOT NULL,
  sha256           bytea NOT NULL,
  period_start     date,
  period_end       date,
  balance          numeric(15,2),
  balance_date     date,
  transactions     int NOT NULL,
  received_by      text NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity_id, sha256),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account (tenant_id, id)
);
SELECT apply_tenant_rls('bank_statement_file');

CREATE TABLE bank_transaction (
  id               uuid NOT NULL PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  entity_id        uuid NOT NULL,
  bank_account_id  uuid NOT NULL,
  file_id          uuid NOT NULL,
  posted_on        date NOT NULL,
  amount           numeric(15,2) NOT NULL CHECK (amount <> 0),
  trn_type         text,
  fit_id           text,
  check_number     text,
  memo             text,
  payee            text,
  dedupe_key       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, bank_account_id, dedupe_key),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account (tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES bank_statement_file (tenant_id, id)
);
CREATE INDEX bank_transaction_date_ix ON bank_transaction (tenant_id, bank_account_id, posted_on);
SELECT apply_tenant_rls('bank_transaction');

GRANT SELECT, INSERT ON chart_account, ledger_period_lock, journal_entry, journal_line,
                        bank_statement_file, bank_transaction TO legacy_app;
GRANT SELECT, INSERT ON bank_account TO legacy_app;
-- Vigência: encerrar conta (valid_to) e ligar a conta bancária à conta contábil.
GRANT UPDATE (valid_to) ON chart_account TO legacy_app;
GRANT UPDATE (ledger_account_id) ON bank_account TO legacy_app;
