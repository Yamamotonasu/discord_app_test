-- mention_user_idsカラムを追加（TEXT配列として保存）
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS mention_user_ids TEXT[] DEFAULT '{}';

