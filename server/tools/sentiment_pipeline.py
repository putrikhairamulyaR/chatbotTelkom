import sys
import json
import traceback
from dataclasses import dataclass

# Optional imports with graceful fallbacks
try:
    from langdetect import detect
except Exception:
    detect = None

# Prefer deep-translator (lebih stabil dibanding googletrans)
try:
    from deep_translator import GoogleTranslator as DeepGoogleTranslator
except Exception:
    DeepGoogleTranslator = None

# googletrans fallback (opsional)
try:
    from googletrans import Translator
except Exception:
    Translator = None

try:
    from textblob import TextBlob
except Exception:
    TextBlob = None

try:
    import nltk
    from nltk.corpus import sentiwordnet as swn
    from nltk.corpus import wordnet as wn
    from nltk import word_tokenize, pos_tag
except Exception:
    nltk = None
    swn = None
    wn = None
    word_tokenize = None
    pos_tag = None

try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
except Exception:
    SentimentIntensityAnalyzer = None


def ensure_nltk_data():
    """Jangan auto-download agresif (sering bikin macet). Download saat build/deploy."""
    if not nltk:
        return False
    try:
        nltk.data.find("tokenizers/punkt")
        nltk.data.find("taggers/averaged_perceptron_tagger")
        nltk.data.find("corpora/wordnet")
        nltk.data.find("corpora/sentiwordnet")
        return True
    except Exception:
        return False


def to_label(score: float) -> str:
    # threshold standar VADER
    if score > 0.05:
        return "positive"
    if score < -0.05:
        return "negative"
    return "neutral"


def swn_polarity(text_en: str) -> float:
    if not (nltk and swn and wn and word_tokenize and pos_tag):
        return 0.0
    if not ensure_nltk_data():
        return 0.0

    try:
        tokens = word_tokenize(text_en)
        tagged = pos_tag(tokens)

        def penn_to_wn(tag):
            if tag.startswith("N"):
                return wn.NOUN
            if tag.startswith("V"):
                return wn.VERB
            if tag.startswith("J"):
                return wn.ADJ
            if tag.startswith("R"):
                return wn.ADV
            return None

        scores = []
        for word, tag in tagged:
            wn_tag = penn_to_wn(tag)
            if not wn_tag:
                continue
            synsets = wn.synsets(word, pos=wn_tag)
            if not synsets:
                continue
            ss = swn.senti_synset(synsets[0].name())
            compound = float(ss.pos_score()) - float(ss.neg_score())
            if compound != 0:
                scores.append(compound)

        if not scores:
            return 0.0

        return max(-1.0, min(1.0, sum(scores) / len(scores)))
    except Exception:
        return 0.0


def vader_polarity(text_en: str) -> float:
    if not SentimentIntensityAnalyzer:
        return 0.0
    try:
        analyzer = SentimentIntensityAnalyzer()
        vs = analyzer.polarity_scores(text_en)
        return float(vs.get("compound", 0.0))
    except Exception:
        return 0.0


def textblob_polarity(text_en: str) -> float:
    if not TextBlob:
        return 0.0
    try:
        return float(TextBlob(text_en).sentiment.polarity)
    except Exception:
        return 0.0


def translate_to_english(text: str):
    """
    RETURNS: (lang_detected, text_en, translated_bool, translator_used)
    - kalau detect ada dan hasil 'en' -> ga usah translate
    - kalau detect ga ada / gagal / unknown -> tetap coba translate (source auto)
    """
    lang = "unknown"
    translated = False
    used = None

    if detect:
        try:
            lang = detect(text)
        except Exception:
            lang = "unknown"

    if lang == "en":
        return lang, text, False, None

    # deep-translator first
    if DeepGoogleTranslator:
        try:
            res = DeepGoogleTranslator(source="auto", target="en").translate(text)
            if res and isinstance(res, str):
                used = "deep-translator"
                translated = True
                return lang, res, translated, used
        except Exception:
            pass

    # googletrans fallback
    if Translator:
        try:
            tr = Translator()
            res = tr.translate(text, dest="en")
            if res and res.text:
                used = "googletrans"
                translated = True
                return lang, res.text, translated, used
        except Exception:
            pass

    return lang, text, False, None


def majority_vote(labels):
    """
    labels: list[str] of 'positive'/'neutral'/'negative'
    Rule:
      - ambil label dengan vote terbanyak
      - kalau tie:
          - kalau tie pos vs neg -> neutral
          - kalau tie melibatkan neutral -> pilih non-neutral (karena biasanya netral itu "lemah")
    """
    if not labels:
        return "neutral"

    counts = {"positive": 0, "neutral": 0, "negative": 0}
    for lab in labels:
        if lab in counts:
            counts[lab] += 1

    maxv = max(counts.values())
    winners = [k for k, v in counts.items() if v == maxv and v > 0]

    if len(winners) == 1:
        return winners[0]

    # tie handling
    if "positive" in winners and "negative" in winners:
        return "neutral"
    # tie neutral + one side -> choose side
    if "positive" in winners and "neutral" in winners:
        return "positive"
    if "negative" in winners and "neutral" in winners:
        return "negative"

    return "neutral"


@dataclass
class Output:
    score: float
    label: str
    lang: str
    text_original: str
    text_en: str
    translated: bool
    translator: str
    methods: dict
    method_labels: dict


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else {}
        text = str(payload.get("text", "")).strip()

        if not text:
            sys.stdout.write(json.dumps({"error": "text required"}))
            return

        lang, text_en, translated, used = translate_to_english(text)

        # compute 3 method scores
        scores = {
            "textblob": textblob_polarity(text_en),
            "vader": vader_polarity(text_en),
            "sentiwordnet": swn_polarity(text_en),
        }

        tb_available = TextBlob is not None
        vd_available = SentimentIntensityAnalyzer is not None
        swn_available = all([nltk, swn, wn, word_tokenize, pos_tag]) and ensure_nltk_data()

        # build available list
        vals = []
        labels_for_vote = []
        method_labels = {}

        if tb_available:
            vals.append(scores["textblob"])
            lab = to_label(scores["textblob"])
            labels_for_vote.append(lab)
            method_labels["textblob"] = lab
        else:
            method_labels["textblob"] = "unavailable"

        if vd_available:
            vals.append(scores["vader"])
            lab = to_label(scores["vader"])
            labels_for_vote.append(lab)
            method_labels["vader"] = lab
        else:
            method_labels["vader"] = "unavailable"

        if swn_available:
            vals.append(scores["sentiwordnet"])
            lab = to_label(scores["sentiwordnet"])
            labels_for_vote.append(lab)
            method_labels["sentiwordnet"] = lab
        else:
            method_labels["sentiwordnet"] = "unavailable"

        # score tetap average (buat numerik), label pakai majority voting
        score = (sum(vals) / len(vals)) if vals else 0.0
        score = max(-1.0, min(1.0, float(score)))
        label = majority_vote(labels_for_vote)

        out = Output(
            score=score,
            label=label,
            lang=lang,
            text_original=text,
            text_en=text_en,
            translated=translated,
            translator=used,
            methods=scores,
            method_labels=method_labels,
        )
        sys.stdout.write(json.dumps(out.__dict__, ensure_ascii=False))
    except Exception:
        sys.stdout.write(json.dumps(
            {"error": "exception", "detail": traceback.format_exc()},
            ensure_ascii=False
        ))


if __name__ == "__main__":
    main()
