import sys
import json
import traceback
from dataclasses import dataclass

# Optional imports with graceful fallbacks
try:
    from langdetect import detect
except Exception:
    detect = None

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
    # Attempt to download needed corpora if not present
    if not nltk:
        return
    try:
        nltk.data.find('tokenizers/punkt')
    except Exception:
        nltk.download('punkt', quiet=True)
    # POS tagger (newer NLTK names this differently on some envs)
    try:
        nltk.data.find('taggers/averaged_perceptron_tagger')
    except Exception:
        try:
            nltk.download('averaged_perceptron_tagger', quiet=True)
        except Exception:
            pass
    try:
        nltk.data.find('corpora/wordnet')
    except Exception:
        nltk.download('wordnet', quiet=True)
    try:
        nltk.data.find('corpora/sentiwordnet')
    except Exception:
        nltk.download('sentiwordnet', quiet=True)


def to_label(score: float) -> str:
    if score > 0.05:
        return 'positive'
    if score < -0.05:
        return 'negative'
    return 'neutral'


def swn_polarity(text_en: str) -> float:
    if not (nltk and swn and wn and word_tokenize and pos_tag):
        return 0.0
    ensure_nltk_data()
    try:
        tokens = word_tokenize(text_en)
        tagged = pos_tag(tokens)
        def penn_to_wn(tag):
            if tag.startswith('N'):
                return wn.NOUN
            if tag.startswith('V'):
                return wn.VERB
            if tag.startswith('J'):
                return wn.ADJ
            if tag.startswith('R'):
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
            # take the first sense as approximation
            s = swn.senti_synset(synsets[0].name())
            if s:
                # convert pos/neg scores to a single [-1,1]
                compound = float(s.pos_score()) - float(s.neg_score())
                if compound != 0:
                    scores.append(compound)
        if not scores:
            return 0.0
        # average
        return max(-1.0, min(1.0, sum(scores) / len(scores)))
    except Exception:
        return 0.0


def vader_polarity(text_en: str) -> float:
    if not SentimentIntensityAnalyzer:
        return 0.0
    try:
        analyzer = SentimentIntensityAnalyzer()
        vs = analyzer.polarity_scores(text_en)
        return float(vs.get('compound', 0.0))
    except Exception:
        return 0.0


def textblob_polarity(text_en: str) -> float:
    if not TextBlob:
        return 0.0
    try:
        return float(TextBlob(text_en).sentiment.polarity)
    except Exception:
        return 0.0


def translate_to_english(text: str) -> (str, str):
    # returns (lang, text_en)
    lang = 'unknown'
    try:
        if detect:
            lang = detect(text)
    except Exception:
        pass

    # If already English or translator unavailable, return as is
    if (lang in ('en', 'unknown')) or not Translator:
        return (lang, text)

    try:
        translator = Translator()
        res = translator.translate(text, dest='en')
        if res and res.text:
            return (lang, res.text)
    except Exception:
        pass
    return (lang, text)


@dataclass
class Output:
    text_original: str
    text_en: str
    lang: str
    methods: dict
    score: float
    label: str


def main():
    try:
        # read JSON from stdin: {"text": "..."}
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else {}
        text = str(payload.get('text', '')).strip()
        if not text:
            print(json.dumps({"error": "text required"}))
            return

        lang, text_en = translate_to_english(text)

        scores = {
            'textblob': textblob_polarity(text_en),
            'vader': vader_polarity(text_en),
            'sentiwordnet': swn_polarity(text_en),
        }
        # combine by mean
        vals = [v for v in scores.values() if isinstance(v, (int, float))]
        score = sum(vals) / len(vals) if vals else 0.0
        score = max(-1.0, min(1.0, float(score)))
        label = to_label(score)

        out = Output(
            text_original=text,
            text_en=text_en,
            lang=lang,
            methods=scores,
            score=score,
            label=label,
        )
        print(json.dumps(out.__dict__, ensure_ascii=False))
    except Exception:
        err = traceback.format_exc()
        print(json.dumps({"error": "exception", "detail": err}))


if __name__ == '__main__':
    main()
