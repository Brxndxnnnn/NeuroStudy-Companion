-- O1.3 / O1.4: BFI-2 and WHO-5 post-session questionnaires, answer validation and scoring.
--
-- 1. Schema additions. questionnaire_questions.facet already exists on production (added by
--    hand alongside the BFI-2 data); it is added here so every database matches.
-- 2. BFI-2 (60 items). Inserted by hand on production on 23 Jun / 4 Jul 2026 and never
--    recorded in a migration. Seeded here with the SAME UUIDs so answers reference identical
--    rows in every database. Existing rows are never overwritten; differences from this seed
--    are reported as WARNINGs.
-- 3. WHO-5 Well-being Index (5 items, 0-5), from Zhaoyu's draft, with fixed UUIDs.
-- 4. Answer validation on session_questionnaire_responses: the question must belong to the
--    questionnaire, clinic_id is taken from the session, and the value must be an integer
--    within the questionnaire's scale.
-- 5. session_questionnaire_scores view: the single scoring definition read by the backend,
--    the PDF and (read-only) the bridge.
--
-- Answers are only submitted on the website; the bridge only reads questionnaires and scores.
--
-- Custom SQLSTATEs (map in backend/src/middleware/errorHandler.js):
--   P2301 session not found (or not visible to this clinic)          -> 404
--   P2302 answer is not an integer within the questionnaire's scale  -> 400
--
-- Safe to re-run: every statement is IF NOT EXISTS / ON CONFLICT DO NOTHING / CREATE OR
-- REPLACE, and the questionnaire settings are reapplied with the same values.
--
-- ⚠ INSTRUMENT WORDING: the Malay and Chinese WHO-5 statements, answer labels and
-- instructions below are working translations. Verify them against the official WHO-5
-- translations before clinical use, as already noted for BFI-2 in LikertSurvey.js.

BEGIN;

-- Lets the RLS-scoped statements below (backfill, row lookups) see every clinic even when
-- this file is not run by a superuser. Transaction-local.
SELECT set_config('app.is_admin', 'true', true);

-- ============================================================
-- 1. Schema additions
-- ============================================================
ALTER TABLE public.questionnaire_questions
    ADD COLUMN IF NOT EXISTS facet text;

-- One answer scale per questionnaire (every BFI-2 item is 1-5, every WHO-5 item 0-5), plus
-- the labels and instructions the website and bridge both display, so neither hard-codes them.
ALTER TABLE public.questionnaires
    ADD COLUMN IF NOT EXISTS code          text,
    ADD COLUMN IF NOT EXISTS scale_min     smallint,
    ADD COLUMN IF NOT EXISTS scale_max     smallint,
    -- [{"value": 1, "label": {"en": "...", "ms": "...", "zh": "..."}}, ...] in display order
    ADD COLUMN IF NOT EXISTS options       jsonb,
    -- {"intro": {"en": ...}, "stem": {"en": ...}}; stem is optional
    ADD COLUMN IF NOT EXISTS instructions  jsonb,
    -- Order the website presents questionnaires in (BFI-2 first, then WHO-5).
    ADD COLUMN IF NOT EXISTS display_order smallint;

ALTER TABLE public.questionnaires
    DROP CONSTRAINT IF EXISTS chk_questionnaires_scale;

ALTER TABLE public.questionnaires
    ADD CONSTRAINT chk_questionnaires_scale
        CHECK (scale_min IS NULL OR scale_max IS NULL OR scale_min < scale_max);

-- Stable key for code to select a questionnaire by, instead of list order or display name.
CREATE UNIQUE INDEX IF NOT EXISTS uq_questionnaires_code
    ON public.questionnaires (code) WHERE code IS NOT NULL;

-- Target for the composite FK on session_questionnaire_responses (section 4).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_questionnaire_questions_id_questionnaire'
          AND conrelid = 'public.questionnaire_questions'::regclass
    ) THEN
        ALTER TABLE public.questionnaire_questions
            ADD CONSTRAINT uq_questionnaire_questions_id_questionnaire
                UNIQUE (question_id, questionnaire_id);
    END IF;
END
$$;

-- ============================================================
-- 2. BFI-2 (Big Five Inventory-2, 60 items)
-- ============================================================
CREATE TEMP TABLE bfi2_seed (
    question_id       uuid,
    question_no       integer,
    en                text,
    ms                text,
    zh                text,
    domain            text,
    is_reverse_scored boolean,
    facet             text
) ON COMMIT DROP;

INSERT INTO bfi2_seed VALUES
    ('d1d58c56-ed2e-439f-8f48-d3db3c64eda9',  1, 'Is outgoing, sociable', 'Bersikap peramah dan suka bergaul', '外向、善于社交', 'E', false, 'Sociability'),
    ('3564ee06-e72e-490c-b6a4-34023da583b3',  2, 'Is compassionate, has a soft heart', 'Berbelas kasihan, mempunyai hati yang lembut', '富有同情心、心肠软', 'A', false, 'Compassion'),
    ('a75f212d-1cab-4c89-8604-665f7f42876d',  3, 'Tends to be disorganized', 'Cenderung tidak teratur', '往往缺乏条理', 'C', true, 'Organization'),
    ('31e8a4c8-48a0-4bb2-b61a-499d13252f39',  4, 'Is relaxed, handles stress well', 'Bersikap tenang, menangani tekanan dengan baik', '放松、能很好地应对压力', 'N', true, 'Anxiety'),
    ('37c54171-4f3b-4415-8ef1-7e021352d625',  5, 'Has few artistic interests', 'Mempunyai sedikit minat terhadap seni', '艺术兴趣较少', 'O', true, 'Aesthetic Sensitivity'),
    ('36984572-d4b5-4250-ae3f-cfefdac05aae',  6, 'Has an assertive personality', 'Mempunyai personaliti yang tegas', '个性坚定自信', 'E', false, 'Assertiveness'),
    ('047700b9-09ba-4cd5-ae56-e771c392bd7a',  7, 'Is respectful, treats others with respect', 'Bersikap hormat, melayan orang lain dengan hormat', '懂得尊重、以礼待人', 'A', false, 'Respectfulness'),
    ('5b1d12a7-d722-419b-b810-7c392803be2e',  8, 'Tends to be lazy', 'Cenderung malas', '往往懒惰', 'C', true, 'Productiveness'),
    ('2c35eb1e-ab62-4f27-84b1-1cae1a4f8dac',  9, 'Stays optimistic after experiencing a setback', 'Kekal optimis setelah mengalami kemunduran', '经历挫折后仍保持乐观', 'N', true, 'Depression'),
    ('7b298f12-317b-41b2-b1a9-3cee51fde6b4', 10, 'Is curious about many different things', 'Mempunyai rasa ingin tahu yang tinggi terhadap banyak perkara yang berbeza', '对许多不同的事物充满好奇', 'O', false, 'Intellectual Curiosity'),
    ('49ebf500-a54f-48a7-b65f-696ae2bfb879', 11, 'Rarely feels excited or eager', 'Jarang merasa teruja atau bersemangat', '很少感到兴奋或渴望', 'E', true, 'Energy Level'),
    ('8d93c536-4eb3-416d-95dd-e5d2ffb562f1', 12, 'Tends to find fault with others', 'Cenderung mencari kesalahan orang lain', '往往挑剔他人', 'A', true, 'Trust'),
    ('b32d6b64-a53f-493b-bb5d-8aaf83767bf8', 13, 'Is dependable, steady', 'Boleh dipercayai, stabil', '可靠、稳重', 'C', false, 'Responsibility'),
    ('39a05c8d-03da-4c08-a101-d0a5316d7160', 14, 'Is moody, has up and down mood swings', 'Berubah-ubah mood, mengalami perubahan mood yang naik dan turun', '情绪化、情绪起伏波动', 'N', false, 'Emotional Volatility'),
    ('ce10ff72-add0-4ac7-abc5-784ffa20482d', 15, 'Is inventive, finds clever ways to do things', 'Bersikap inventif, mencari cara yang bijak untuk melakukan sesuatu', '富有创造力、善于找到巧妙的方法做事', 'O', false, 'Creative Imagination'),
    ('df9a6f20-d2b5-4a42-8dfe-0fa4bbbd25af', 16, 'Tends to be quiet', 'Cenderung pendiam', '往往安静', 'E', true, 'Sociability'),
    ('8c10c628-5ae6-433b-ba8b-aab521460bdd', 17, 'Feels little sympathy for others', 'Merasakan sedikit simpati terhadap orang lain', '对他人很少同情', 'A', true, 'Compassion'),
    ('8da12b98-97cc-47c0-940d-fabc68da9af1', 18, 'Is systematic, likes to keep things in order', 'Bersikap sistematik, suka mengekalkan perkara dalam keadaan teratur', '有条理、喜欢保持事物井然有序', 'C', false, 'Organization'),
    ('b5b049ec-6c2e-4b77-ad30-b45484e03279', 19, 'Can be tense', 'Boleh menjadi tegang', '可能会紧张', 'N', false, 'Anxiety'),
    ('b8a91e36-11b0-4f53-b8e2-ad223b2c51cc', 20, 'Is fascinated by art, music, or literature', 'Tertarik kepada seni, muzik, atau sastera', '对艺术、音乐或文学着迷', 'O', false, 'Aesthetic Sensitivity'),
    ('75bf1bb0-3930-454a-a4bc-0e7ac252201d', 21, 'Is dominant, acts as a leader', 'Bersikap dominan, bertindak sebagai pemimpin', '占主导地位、表现得像领导者', 'E', false, 'Assertiveness'),
    ('94c9a57e-caf7-4e2c-8f8c-327fb20be747', 22, 'Starts arguments with others', 'Memulakan pertengkaran dengan orang lain', '与他人发生争执', 'A', true, 'Respectfulness'),
    ('9ebeb46d-4828-4a9f-aaa0-bc93583877c8', 23, 'Has difficulty getting started on tasks', 'Mengalami kesukaran untuk memulakan tugas', '难以开始任务', 'C', true, 'Productiveness'),
    ('346b1b29-b75e-4335-a8bd-8c69ab9d5c2f', 24, 'Feels secure, comfortable with self', 'Merasa selamat, selesa dengan diri sendiri', '感到安全、对自己感到舒适', 'N', true, 'Depression'),
    ('df21a836-f56a-43d3-a7d8-ca4715595d03', 25, 'Avoids intellectual, philosophical discussions', 'Mengelakkan perbincangan intelektual, falsafah', '回避智力、哲学讨论', 'O', true, 'Intellectual Curiosity'),
    ('90745451-aa42-4e7a-be19-2068b2092d42', 26, 'Is less active than other people', 'Kurang aktif berbanding orang lain', '比别人不那么活跃', 'E', true, 'Energy Level'),
    ('179f723c-d560-437d-befc-a3b1ffac872f', 27, 'Has a forgiving nature', 'Mempunyai sifat yang suka memaafkan', '有宽容的天性', 'A', false, 'Trust'),
    ('7bcc30ae-9f20-4b5e-a40e-81aba904fe20', 28, 'Can be somewhat careless', 'Boleh menjadi agak cuai', '可能会有些粗心', 'C', true, 'Responsibility'),
    ('74dbb08e-498d-4453-86d3-3331ae12eba5', 29, 'Is emotionally stable, not easily upset', 'Stabil secara emosi, tidak mudah kecewa', '情绪稳定、不易心烦', 'N', true, 'Emotional Volatility'),
    ('719eaea0-ed7c-46d0-9300-129134100241', 30, 'Has little creativity', 'Mempunyai sedikit kreativiti', '创造力较少', 'O', true, 'Creative Imagination'),
    ('390a74aa-8287-46e4-b1ca-14c35fc475c5', 31, 'Is sometimes shy, introverted', 'Kadang-kadang pemalu, introvert', '有时害羞、内向', 'E', true, 'Sociability'),
    ('da77d5d4-7d1c-4e89-88a0-8b8f7398e85a', 32, 'Is helpful and unselfish with others', 'Suka membantu dan tidak mementingkan diri sendiri dengan orang lain', '乐于助人且不自私', 'A', false, 'Compassion'),
    ('454ed63a-4f1c-4917-af90-3c484275ac4a', 33, 'Keeps things neat and tidy', 'Mengekalkan perkara kemas dan teratur', '保持事物整洁有序', 'C', false, 'Organization'),
    ('c51409da-bc14-4c2b-81fd-c7264996beee', 34, 'Worries a lot', 'Banyak risau', '经常担忧', 'N', false, 'Anxiety'),
    ('08aa34bd-1572-463b-b6da-c4e89f5cdb94', 35, 'Values art and beauty', 'Menghargai seni dan keindahan', '重视艺术和美', 'O', false, 'Aesthetic Sensitivity'),
    ('5a8b6934-5b87-4a08-9a21-41a9566242c9', 36, 'Finds it hard to influence people', 'Mendapati sukar untuk mempengaruhi orang', '觉得很难影响他人', 'E', true, 'Assertiveness'),
    ('d1315d99-bd17-451f-88c9-142643d774bf', 37, 'Is sometimes rude to others', 'Kadang-kadang kasar terhadap orang lain', '有时对他人粗鲁', 'A', true, 'Respectfulness'),
    ('ba574c6f-a8d4-4c16-b864-d1a3404be185', 38, 'Is efficient, gets things done', 'Cekap, menyelesaikan perkara', '高效、能完成任务', 'C', false, 'Productiveness'),
    ('11c02ad6-79a1-472f-86ec-0cb2495e88d5', 39, 'Often feels sad', 'Sering berasa sedih', '经常感到悲伤', 'N', false, 'Depression'),
    ('2b6cecf0-08c9-4294-bc04-d3628592ff79', 40, 'Is complex, a deep thinker', 'Kompleks, seorang pemikir yang mendalam', '复杂、思想深刻', 'O', false, 'Intellectual Curiosity'),
    ('c1b21d2c-a44e-4d3b-af5f-d086db6e116b', 41, 'Is full of energy', 'Penuh tenaga', '精力充沛', 'E', false, 'Energy Level'),
    ('b9fbe603-61b0-4878-8d29-f3f6aefd2406', 42, 'Is suspicious of others'' intentions', 'Syak wasangka terhadap niat orang lain', '怀疑他人的意图', 'A', true, 'Trust'),
    ('5dd49a6e-b151-43fa-bf9e-ddea62d234cf', 43, 'Is reliable, can always be counted on', 'Boleh dipercayai, sentiasa boleh diharap', '可靠、总是可以信赖', 'C', false, 'Responsibility'),
    ('918acc36-0c17-4f19-a35c-f9b9fa71a601', 44, 'Keeps their emotions under control', 'Mengekalkan emosi mereka di bawah kawalan', '能控制自己的情绪', 'N', true, 'Emotional Volatility'),
    ('d677da2f-d90d-4674-b9ad-1e279b68f0d4', 45, 'Has difficulty imagining things', 'Mengalami kesukaran untuk membayangkan perkara', '难以想象事物', 'O', true, 'Creative Imagination'),
    ('3389c9ef-eecf-438f-9699-6f2e651e44e4', 46, 'Is talkative', 'Suka bercakap', '健谈', 'E', false, 'Sociability'),
    ('e258a941-61e9-4b3e-8534-27cd1444b3f7', 47, 'Can be cold and uncaring', 'Boleh menjadi dingin dan tidak mengambil berat', '可能会冷漠和不关心', 'A', true, 'Compassion'),
    ('42840687-04be-4481-b7f0-875f8043e74e', 48, 'Leaves a mess, doesn''t clean up', 'Meninggalkan keadaan berselerak, tidak mengemas', '弄得一团糟、不收拾', 'C', true, 'Organization'),
    ('cdee52ca-761b-4b51-a3a2-3903d7996c1e', 49, 'Rarely feels anxious or afraid', 'Jarang berasa cemas atau takut', '很少感到焦虑或害怕', 'N', true, 'Anxiety'),
    ('3d82484f-db22-48ca-969f-f232a49be70b', 50, 'Thinks poetry and plays are boring', 'Berfikir bahawa puisi dan drama membosankan', '认为诗歌和戏剧很无聊', 'O', true, 'Aesthetic Sensitivity'),
    ('b8e05465-e920-4c5b-85f8-0076ef39b298', 51, 'Prefers to have others take charge', 'Lebih suka orang lain mengambil alih', '更喜欢让别人负责', 'E', true, 'Assertiveness'),
    ('5c39d28b-d3c1-41bf-913f-a25d0cc8eba7', 52, 'Is polite, courteous to others', 'Sopan, bertata krama terhadap orang lain', '有礼貌、待人谦恭', 'A', false, 'Respectfulness'),
    ('3991dbb2-cc1e-4b1c-9ddc-6b2c37b11db8', 53, 'Is persistent, works until the task is finished', 'Tekun, bekerja sehingga tugas selesai', '坚持不懈、工作直到任务完成', 'C', false, 'Productiveness'),
    ('6ac0cae5-2cab-4ebc-afe9-a7d5ad1dbe6b', 54, 'Tends to feel depressed, blue', 'Cenderung merasa tertekan, murung', '往往感到沮丧、忧郁', 'N', false, 'Depression'),
    ('968ef8ca-0a58-4afe-a7e6-b21fd4e83575', 55, 'Has little interest in abstract ideas', 'Mempunyai sedikit minat terhadap idea abstrak', '对抽象概念兴趣不大', 'O', true, 'Intellectual Curiosity'),
    ('e63d09aa-e057-40ec-8b9f-a3c7aedae815', 56, 'Shows a lot of enthusiasm', 'Menunjukkan banyak semangat', '表现出极大的热情', 'E', false, 'Energy Level'),
    ('70bbe054-f00b-49e4-ad61-724811b45d77', 57, 'Assumes the best about people', 'Menganggap yang terbaik tentang orang', '往好处想他人', 'A', false, 'Trust'),
    ('2f644428-59e0-43ea-88da-bfc87173e01b', 58, 'Sometimes behaves irresponsibly', 'Kadang-kadang bertindak secara tidak bertanggungjawab', '有时行为不负责任', 'C', true, 'Responsibility'),
    ('abcd9253-f5fc-4bc2-937b-1cfa399ee674', 59, 'Is temperamental, gets emotional easily', 'Bersikap temperamen, mudah menjadi emosional', '脾气暴躁、容易情绪化', 'N', false, 'Emotional Volatility'),
    ('8f96956f-2e30-4332-9b15-f9eff2ee5116', 60, 'Is original, comes up with new ideas', 'Asli, menjana idea baharu', '有独创性、能提出新想法', 'O', false, 'Creative Imagination');

-- Production's BFI-2 row keeps its id; it is only given its code here. A database that has
-- the BFI-2 under another id (e.g. seeded from an older dump) is matched by name instead.
UPDATE public.questionnaires
SET code = 'bfi2'
WHERE code IS NULL
  AND (
      questionnaire_id = '3329bb5c-e73f-4dfc-8cb3-c6f44cd7e435'
      OR (
          lower(name) = lower('BFI-2 Questionnaires')
          AND NOT EXISTS (
              SELECT 1 FROM public.questionnaires
              WHERE questionnaire_id = '3329bb5c-e73f-4dfc-8cb3-c6f44cd7e435'
          )
      )
  );

INSERT INTO public.questionnaires (questionnaire_id, code, name, description, version)
VALUES (
    '3329bb5c-e73f-4dfc-8cb3-c6f44cd7e435',
    'bfi2',
    'BFI-2 Questionnaires',
    'Post session questionnaire. English, Malay and Chinese language supported.',
    '1.0'
)
ON CONFLICT DO NOTHING;

-- ON CONFLICT DO NOTHING (no target) also covers UNIQUE (questionnaire_id, question_no),
-- so a database with the same items under different UUIDs keeps its rows.
INSERT INTO public.questionnaire_questions (
    question_id, questionnaire_id, question_no, statement, response_type, domain, is_reverse_scored, facet
)
SELECT
    s.question_id,
    q.questionnaire_id,
    s.question_no,
    jsonb_build_object('en', s.en, 'ms', s.ms, 'zh', s.zh),
    'likert_5',
    s.domain,
    s.is_reverse_scored,
    s.facet
FROM bfi2_seed s
CROSS JOIN public.questionnaires q
WHERE q.code = 'bfi2'
ON CONFLICT DO NOTHING;

-- Anchor labels and instructions moved here from frontend/src/components/LikertSurvey.js
-- (same wording), so the website and bridge share one copy.
UPDATE public.questionnaires
SET scale_min = 1,
    scale_max = 5,
    display_order = 1,
    options = '[
        {"value": 1, "label": {"en": "Disagree strongly",   "ms": "Sangat tidak setuju",       "zh": "非常不同意"}},
        {"value": 2, "label": {"en": "Disagree a little",   "ms": "Kurang setuju",             "zh": "有点不同意"}},
        {"value": 3, "label": {"en": "Neutral; no opinion", "ms": "Berkecuali; tiada pendapat", "zh": "中立；没有意见"}},
        {"value": 4, "label": {"en": "Agree a little",      "ms": "Sedikit setuju",            "zh": "有点同意"}},
        {"value": 5, "label": {"en": "Agree strongly",      "ms": "Sangat setuju",             "zh": "非常同意"}}
    ]'::jsonb,
    instructions = '{
        "intro": {
            "en": "Here are a number of characteristics that may or may not apply to you. For example, do you agree that you are someone who likes to spend time with others? Please select a number next to each statement to indicate the extent to which you agree or disagree with that statement.",
            "ms": "Berikut adalah beberapa ciri yang mungkin atau mungkin tidak menggambarkan diri anda. Sebagai contoh, adakah anda bersetuju bahawa anda seorang yang suka meluangkan masa bersama orang lain? Sila pilih nombor di sebelah setiap pernyataan untuk menunjukkan sejauh mana anda bersetuju atau tidak bersetuju dengan pernyataan tersebut.",
            "zh": "以下是一些可能适合或不适合您的特征。例如，您是否同意自己是一个喜欢与他人共处的人？请在每个陈述旁选择一个数字，以表明您对该陈述同意或不同意的程度。"
        },
        "stem": {"en": "I am someone who…", "ms": "Saya seorang yang…", "zh": "我是一个…"}
    }'::jsonb
WHERE code = 'bfi2';

-- Report (never overwrite) existing BFI-2 rows that differ from this seed, so a divergence
-- between production and other databases is visible in the migration output.
DO $$
DECLARE
    v_diff record;
BEGIN
    FOR v_diff IN
        SELECT s.question_no
        FROM bfi2_seed s
        JOIN public.questionnaire_questions qq ON qq.question_id = s.question_id
        WHERE qq.statement IS DISTINCT FROM jsonb_build_object('en', s.en, 'ms', s.ms, 'zh', s.zh)
           OR qq.domain IS DISTINCT FROM s.domain
           OR qq.is_reverse_scored IS DISTINCT FROM s.is_reverse_scored
           OR qq.facet IS DISTINCT FROM s.facet
           OR qq.question_no IS DISTINCT FROM s.question_no
        ORDER BY s.question_no
    LOOP
        RAISE WARNING 'BFI-2 item % differs from the seed in 024; existing row kept', v_diff.question_no;
    END LOOP;
END
$$;

-- ============================================================
-- 3. WHO-5 Well-being Index (5 items, 0 = at no time ... 5 = all of the time)
-- ============================================================
-- A WHO-5 inserted earlier from Zhaoyu's draft (random UUID) is adopted by name rather
-- than duplicated.
UPDATE public.questionnaires
SET code = 'who5'
WHERE code IS NULL
  AND lower(name) = lower('WHO-5 Well-being Index')
  AND NOT EXISTS (SELECT 1 FROM public.questionnaires WHERE code = 'who5');

INSERT INTO public.questionnaires (questionnaire_id, code, name, description, version)
VALUES (
    '31ed48e7-614d-489b-930f-0143ff11c8e2',
    'who5',
    'WHO-5 Well-being Index',
    'Post-session well-being questionnaire. Measures well-being over the past two weeks. English, Malay and Chinese supported.',
    '1.0'
)
ON CONFLICT DO NOTHING;

INSERT INTO public.questionnaire_questions (
    question_id, questionnaire_id, question_no, statement, response_type, domain, is_reverse_scored, facet
)
SELECT
    w.question_id,
    q.questionnaire_id,
    w.question_no,
    jsonb_build_object('en', w.en, 'ms', w.ms, 'zh', w.zh),
    'likert_6',
    NULL,
    false,
    NULL
FROM (
    VALUES
        ('9cf5dbc5-7d55-46fc-b749-3ab4480d43d1'::uuid, 1,
         'I have felt cheerful and in good spirits.',
         'Saya berasa ceria dan bersemangat.',
         '我感觉快乐、心情舒畅。'),
        ('e3ad5a48-8a23-4d87-ac90-867f1f50d524'::uuid, 2,
         'I have felt calm and relaxed.',
         'Saya berasa tenang dan santai.',
         '我感觉宁静和放松。'),
        ('d590afbc-6195-4473-9b29-324b0a1813e5'::uuid, 3,
         'I have felt active and vigorous.',
         'Saya berasa aktif dan bertenaga.',
         '我感觉充满活力、精力充沛。'),
        ('fe1d276e-abb7-4182-8e0c-03f2c5d53524'::uuid, 4,
         'I woke up feeling fresh and rested.',
         'Saya bangun tidur dengan rasa segar dan cukup rehat.',
         '我睡醒时感到清新、得到了足够的休息。'),
        ('05d7a17a-4766-4513-bd11-89a069b82d4d'::uuid, 5,
         'My daily life has been filled with things that interest me.',
         'Kehidupan seharian saya dipenuhi dengan perkara yang menarik minat saya.',
         '我每天生活充满了有趣的事情。')
) AS w(question_id, question_no, en, ms, zh)
CROSS JOIN public.questionnaires q
WHERE q.code = 'who5'
ON CONFLICT DO NOTHING;

-- Options run from 5 down to 0, the order of the official form.
UPDATE public.questionnaires
SET scale_min = 0,
    scale_max = 5,
    display_order = 2,
    options = '[
        {"value": 5, "label": {"en": "All of the time",         "ms": "Sepanjang masa",               "zh": "所有时间"}},
        {"value": 4, "label": {"en": "Most of the time",        "ms": "Kebanyakan masa",              "zh": "大部分时间"}},
        {"value": 3, "label": {"en": "More than half the time", "ms": "Lebih daripada separuh masa",  "zh": "一半以上时间"}},
        {"value": 2, "label": {"en": "Less than half the time", "ms": "Kurang daripada separuh masa", "zh": "不到一半时间"}},
        {"value": 1, "label": {"en": "Some of the time",        "ms": "Ada kalanya",                  "zh": "有时"}},
        {"value": 0, "label": {"en": "At no time",              "ms": "Tidak pernah",                 "zh": "从未"}}
    ]'::jsonb,
    instructions = '{
        "intro": {
            "en": "Please respond to each item by selecting one option per row, regarding how you felt in the last two weeks.",
            "ms": "Sila jawab setiap item dengan memilih satu pilihan bagi setiap baris, berdasarkan perasaan anda dalam dua minggu yang lalu.",
            "zh": "请根据您过去两周的感受，为每一项选择一个选项。"
        }
    }'::jsonb
WHERE code = 'who5';

-- Abort the whole migration if either instrument is not exactly as scored below.
DO $$
DECLARE
    v_bfi2_items integer;
    v_bfi2_reversed integer;
    v_bfi2_bad_domains integer;
    v_bfi2_bad_facets integer;
    v_who5_items integer;
BEGIN
    SELECT COUNT(*), COUNT(*) FILTER (WHERE qq.is_reverse_scored)
    INTO v_bfi2_items, v_bfi2_reversed
    FROM public.questionnaire_questions qq
    JOIN public.questionnaires q USING (questionnaire_id)
    WHERE q.code = 'bfi2';

    SELECT COUNT(*) INTO v_bfi2_bad_domains
    FROM (
        SELECT qq.domain
        FROM public.questionnaire_questions qq
        JOIN public.questionnaires q USING (questionnaire_id)
        WHERE q.code = 'bfi2'
        GROUP BY qq.domain
        HAVING COUNT(*) <> 12 OR qq.domain IS NULL OR qq.domain NOT IN ('E', 'A', 'C', 'N', 'O')
    ) d;

    SELECT COUNT(*) INTO v_bfi2_bad_facets
    FROM (
        SELECT qq.facet
        FROM public.questionnaire_questions qq
        JOIN public.questionnaires q USING (questionnaire_id)
        WHERE q.code = 'bfi2'
        GROUP BY qq.domain, qq.facet
        HAVING COUNT(*) <> 4 OR qq.facet IS NULL
    ) f;

    SELECT COUNT(*) INTO v_who5_items
    FROM public.questionnaire_questions qq
    JOIN public.questionnaires q USING (questionnaire_id)
    WHERE q.code = 'who5';

    IF v_bfi2_items <> 60 OR v_bfi2_reversed <> 30 OR v_bfi2_bad_domains <> 0 OR v_bfi2_bad_facets <> 0 THEN
        RAISE EXCEPTION 'BFI-2 is not 60 items / 30 reverse-keyed / 5 domains x 12 / 15 facets x 4 (items %, reversed %, bad domains %, bad facets %)',
            v_bfi2_items, v_bfi2_reversed, v_bfi2_bad_domains, v_bfi2_bad_facets;
    END IF;

    IF v_who5_items <> 5 THEN
        RAISE EXCEPTION 'WHO-5 must have exactly 5 items; found %', v_who5_items;
    END IF;
END
$$;

-- ============================================================
-- 4. Answer validation on session_questionnaire_responses
-- ============================================================
-- An answer's question must belong to the questionnaire it is filed under; previously only
-- question_id was checked.
ALTER TABLE public.session_questionnaire_responses
    DROP CONSTRAINT IF EXISTS fk_session_questionnaire_responses_question;

ALTER TABLE public.session_questionnaire_responses
    ADD CONSTRAINT fk_session_questionnaire_responses_question
        FOREIGN KEY (question_id, questionnaire_id)
        REFERENCES public.questionnaire_questions(question_id, questionnaire_id)
        ON DELETE RESTRICT;

-- Existing answers were stored with the submitting user's clinic (NULL for admins) rather
-- than the session's. Align them with their session so RLS and the bridge see them.
UPDATE public.session_questionnaire_responses r
SET clinic_id = s.clinic_id
FROM public.sessions s
WHERE s.session_id = r.session_id
  AND s.clinic_id IS NOT NULL
  AND r.clinic_id IS DISTINCT FROM s.clinic_id;

-- clinic_id is left nullable: its FK is ON DELETE SET NULL. The trigger below guarantees
-- every new or changed answer carries its session's clinic.
CREATE OR REPLACE FUNCTION public.session_questionnaire_responses_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_clinic_id uuid;
    v_scale_min smallint;
    v_scale_max smallint;
    v_value numeric;
BEGIN
    -- Runs as the caller, so RLS hides other clinics' sessions: a technician can no longer
    -- file answers against another clinic's session by guessing its ID.
    SELECT s.clinic_id
    INTO v_clinic_id
    FROM public.sessions s
    WHERE s.session_id = NEW.session_id;

    IF NOT FOUND OR v_clinic_id IS NULL THEN
        RAISE EXCEPTION 'Session not found'
            USING ERRCODE = 'P2301';
    END IF;

    NEW.clinic_id := v_clinic_id;

    SELECT q.scale_min, q.scale_max
    INTO v_scale_min, v_scale_max
    FROM public.questionnaires q
    WHERE q.questionnaire_id = NEW.questionnaire_id;

    IF v_scale_min IS NULL OR v_scale_max IS NULL THEN
        RAISE EXCEPTION 'Questionnaire has no answer scale configured'
            USING ERRCODE = 'P2302';
    END IF;

    IF jsonb_typeof(NEW.response_value) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Answer must be a number between % and %', v_scale_min, v_scale_max
            USING ERRCODE = 'P2302';
    END IF;

    v_value := (NEW.response_value #>> '{}')::numeric;
    IF v_value <> trunc(v_value) OR v_value < v_scale_min OR v_value > v_scale_max THEN
        RAISE EXCEPTION 'Answer must be a whole number between % and %', v_scale_min, v_scale_max
            USING ERRCODE = 'P2302';
    END IF;

    RETURN NEW;
END;
$function$;

-- Created after the backfill so existing rows are not re-validated by it; the scores view
-- below would fail loudly on any legacy non-integer value instead.
DROP TRIGGER IF EXISTS trg_session_questionnaire_responses_guard ON public.session_questionnaire_responses;

CREATE TRIGGER trg_session_questionnaire_responses_guard
BEFORE INSERT OR UPDATE
ON public.session_questionnaire_responses
FOR EACH ROW
EXECUTE FUNCTION public.session_questionnaire_responses_guard();

-- ============================================================
-- 5. Scoring view
--
-- One row per session x questionnaire at each level:
--   'total'  - every item           (WHO-5: raw_score 0-25, percentage_score = raw x 4)
--   'domain' - BFI-2 E/A/C/N/O      (mean_score of 12 items, 1-5)
--   'facet'  - BFI-2 15 facets      (mean_score of 4 items, 1-5)
-- Reverse-keyed items are scored as scale_min + scale_max - answer (BFI-2: 6 - answer).
-- percentage_score = (raw - min*n) / ((max - min)*n) * 100, which for WHO-5 is exactly the
-- standard raw x 4. Scores over partially answered questionnaires are returned with
-- is_complete = false rather than hidden.
--
-- security_invoker: the caller's RLS applies to the underlying answers. Without it the view
-- would run as its owner and expose every clinic's scores, e.g. to clinic bridge logins.
-- ============================================================
CREATE OR REPLACE VIEW public.session_questionnaire_scores
WITH (security_invoker = true) AS
WITH scored AS (
    SELECT
        r.session_id,
        r.clinic_id,
        q.questionnaire_id,
        q.code AS questionnaire_code,
        q.scale_min,
        q.scale_max,
        qq.domain,
        qq.facet,
        CASE
            WHEN qq.is_reverse_scored
                THEN q.scale_min + q.scale_max - (r.response_value #>> '{}')::integer
            ELSE (r.response_value #>> '{}')::integer
        END AS item_score
    FROM public.session_questionnaire_responses r
    JOIN public.questionnaire_questions qq ON qq.question_id = r.question_id
    JOIN public.questionnaires q ON q.questionnaire_id = r.questionnaire_id
),
expected AS (
    SELECT
        qq.questionnaire_id,
        qq.domain,
        qq.facet,
        GROUPING(qq.domain, qq.facet) AS grouping_level,
        COUNT(*)::integer AS expected_items
    FROM public.questionnaire_questions qq
    GROUP BY GROUPING SETS (
        (qq.questionnaire_id),
        (qq.questionnaire_id, qq.domain),
        (qq.questionnaire_id, qq.domain, qq.facet)
    )
),
answered AS (
    SELECT
        s.session_id,
        s.clinic_id,
        s.questionnaire_id,
        s.questionnaire_code,
        s.scale_min,
        s.scale_max,
        s.domain,
        s.facet,
        -- GROUPING() is a bitmask of the columns rolled up: 3 = total, 1 = domain, 0 = facet.
        GROUPING(s.domain, s.facet) AS grouping_level,
        COUNT(*)::integer AS answered_items,
        SUM(s.item_score)::integer AS raw_score
    FROM scored s
    GROUP BY GROUPING SETS (
        (s.session_id, s.clinic_id, s.questionnaire_id, s.questionnaire_code, s.scale_min, s.scale_max),
        (s.session_id, s.clinic_id, s.questionnaire_id, s.questionnaire_code, s.scale_min, s.scale_max, s.domain),
        (s.session_id, s.clinic_id, s.questionnaire_id, s.questionnaire_code, s.scale_min, s.scale_max, s.domain, s.facet)
    )
)
SELECT
    a.session_id,
    a.clinic_id,
    a.questionnaire_id,
    a.questionnaire_code,
    CASE a.grouping_level WHEN 3 THEN 'total' WHEN 1 THEN 'domain' ELSE 'facet' END AS score_level,
    a.domain,
    a.facet,
    a.answered_items,
    e.expected_items,
    a.answered_items = e.expected_items AS is_complete,
    a.raw_score,
    ROUND(a.raw_score::numeric / a.answered_items, 2) AS mean_score,
    ROUND(
        (a.raw_score - a.scale_min * a.answered_items) * 100.0
        / ((a.scale_max - a.scale_min) * a.answered_items),
        1
    ) AS percentage_score
FROM answered a
JOIN expected e
  ON e.questionnaire_id = a.questionnaire_id
 AND e.grouping_level = a.grouping_level
 AND e.domain IS NOT DISTINCT FROM a.domain
 AND e.facet IS NOT DISTINCT FROM a.facet
-- Questionnaires without domains/facets (WHO-5) only get their total row.
WHERE a.grouping_level = 3
   OR (a.grouping_level = 1 AND a.domain IS NOT NULL)
   OR (a.grouping_level = 0 AND a.facet IS NOT NULL);

-- ============================================================
-- Privileges.
--
-- The bridge displays questionnaires, answers and scores but never writes them. The
-- questionnaire tables hold instrument definitions only (no patient data); answers stay
-- behind the existing clinic-scoped bridge policy, which the security_invoker view honours.
-- The view's grants are explicit because 002's default privileges would otherwise give
-- bridge_writer ALL on it.
-- ============================================================
REVOKE ALL ON public.session_questionnaire_scores FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bridge_writer') THEN
    EXECUTE 'REVOKE ALL ON public.session_questionnaire_scores FROM bridge_writer';
    EXECUTE 'GRANT SELECT ON TABLE public.questionnaires, public.questionnaire_questions, public.session_questionnaire_scores TO bridge_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT ON public.session_questionnaire_scores TO app_user';
  END IF;
END
$$;

COMMIT;
