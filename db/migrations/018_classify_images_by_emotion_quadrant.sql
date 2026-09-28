-- Categorise images from their OASIS valence/arousal quadrant.
-- Existing quadrant categories are preserved, regardless of letter casing.
UPDATE public.images
SET category = CASE
    WHEN valence_mean >= 4 AND arousal_mean >= 4 THEN 'happy'
    WHEN valence_mean >= 4 AND arousal_mean < 4 THEN 'calm'
    WHEN valence_mean < 4 AND arousal_mean >= 4 THEN 'fear'
    WHEN valence_mean < 4 AND arousal_mean < 4 THEN 'sad'
END
WHERE (category IS NULL OR LOWER(category) NOT IN ('happy', 'calm', 'fear', 'sad'))
  AND valence_mean IS NOT NULL
  AND arousal_mean IS NOT NULL;
