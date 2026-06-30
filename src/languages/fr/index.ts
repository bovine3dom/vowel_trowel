import type { LanguageDataset } from "../types";

export const frenchDataset: LanguageDataset = {
  id: "fr",
  name: "French",
  autonym: "francais",
  defaultSpeechLang: "fr-FR",
  phonemes: [
    { id: "fr-u", ipa: "/u/", label: "close back rounded vowel", category: "vowel" },
    { id: "fr-y", ipa: "/y/", label: "close front rounded vowel", category: "vowel" },
    { id: "fr-e", ipa: "/e/", label: "close-mid front vowel", category: "vowel" },
    { id: "fr-epsilon", ipa: "/ɛ/", label: "open-mid front vowel", category: "vowel" },
    { id: "fr-o", ipa: "/o/", label: "close-mid back rounded vowel", category: "vowel" },
    { id: "fr-open-o", ipa: "/ɔ/", label: "open-mid back rounded vowel", category: "vowel" },
    { id: "fr-an", ipa: "/ɑ̃/", label: "open back nasal vowel", category: "vowel" },
    { id: "fr-in", ipa: "/ɛ̃/", label: "open-mid front nasal vowel", category: "vowel" },
    { id: "fr-on", ipa: "/ɔ̃/", label: "open-mid back nasal vowel", category: "vowel" },
    { id: "fr-s", ipa: "/s/", label: "voiceless alveolar fricative", category: "consonant" },
    { id: "fr-z", ipa: "/z/", label: "voiced alveolar fricative", category: "consonant" },
    { id: "fr-sh", ipa: "/ʃ/", label: "voiceless postalveolar fricative", category: "consonant" },
    { id: "fr-zh", ipa: "/ʒ/", label: "voiced postalveolar fricative", category: "consonant" },
  ],
  contrasts: [
    {
      id: "fr-u-y",
      phonemeIds: ["fr-u", "fr-y"],
      label: "/u/ vs /y/",
      category: "vowel",
      description: "Back rounded /u/ against front rounded /y/.",
      tags: ["rounded", "front-back"],
    },
    {
      id: "fr-e-epsilon",
      phonemeIds: ["fr-e", "fr-epsilon"],
      label: "/e/ vs /ɛ/",
      category: "vowel",
      description: "Close-mid /e/ against open-mid /ɛ/.",
      tags: ["mid-vowels"],
    },
    {
      id: "fr-o-open-o",
      phonemeIds: ["fr-o", "fr-open-o"],
      label: "/o/ vs /ɔ/",
      category: "vowel",
      description: "Close-mid /o/ against open-mid /ɔ/.",
      tags: ["mid-vowels", "rounded"],
    },
    {
      id: "fr-an-in",
      phonemeIds: ["fr-an", "fr-in"],
      label: "/ɑ̃/ vs /ɛ̃/",
      category: "vowel",
      description: "Two common French nasal vowels.",
      tags: ["nasal"],
    },
    {
      id: "fr-an-on",
      phonemeIds: ["fr-an", "fr-on"],
      label: "/ɑ̃/ vs /ɔ̃/",
      category: "vowel",
      description: "Back nasal vowel contrast.",
      tags: ["nasal"],
    },
    {
      id: "fr-s-z",
      phonemeIds: ["fr-s", "fr-z"],
      label: "/s/ vs /z/",
      category: "consonant",
      description: "Voiceless against voiced alveolar fricative.",
      tags: ["voicing", "fricatives"],
    },
    {
      id: "fr-sh-zh",
      phonemeIds: ["fr-sh", "fr-zh"],
      label: "/ʃ/ vs /ʒ/",
      category: "consonant",
      description: "Voiceless against voiced postalveolar fricative.",
      tags: ["voicing", "fricatives"],
    },
  ],
  minimalPairs: [
    {
      id: "fr-u-y-roue-rue",
      contrastId: "fr-u-y",
      terms: [
        {
          id: "fr-word-roue",
          phonemeId: "fr-u",
          word: { id: "fr-word-roue", written: "roue", ipa: "/ʁu/", audio: [] },
        },
        {
          id: "fr-word-rue",
          phonemeId: "fr-y",
          word: { id: "fr-word-rue", written: "rue", ipa: "/ʁy/", audio: [] },
        },
      ],
      tags: ["starter", "tts-placeholder"],
    },
    {
      id: "fr-u-y-vous-vu",
      contrastId: "fr-u-y",
      terms: [
        {
          id: "fr-word-vous",
          phonemeId: "fr-u",
          word: { id: "fr-word-vous", written: "vous", ipa: "/vu/", audio: [] },
        },
        {
          id: "fr-word-vu",
          phonemeId: "fr-y",
          word: { id: "fr-word-vu", written: "vu", ipa: "/vy/", audio: [] },
        },
      ],
      tags: ["starter", "tts-placeholder"],
    },
    {
      id: "fr-e-epsilon-des-des",
      contrastId: "fr-e-epsilon",
      terms: [
        {
          id: "fr-word-des",
          phonemeId: "fr-e",
          word: { id: "fr-word-des", written: "des", ipa: "/de/", audio: [] },
        },
        {
          id: "fr-word-des-grave",
          phonemeId: "fr-epsilon",
          word: { id: "fr-word-des-grave", written: "dès", ipa: "/dɛ/", audio: [] },
        },
      ],
      tags: ["starter", "tts-placeholder"],
    },
    {
      id: "fr-o-open-o-paume-pomme",
      contrastId: "fr-o-open-o",
      terms: [
        {
          id: "fr-word-paume",
          phonemeId: "fr-o",
          word: { id: "fr-word-paume", written: "paume", ipa: "/pom/", audio: [] },
        },
        {
          id: "fr-word-pomme",
          phonemeId: "fr-open-o",
          word: { id: "fr-word-pomme", written: "pomme", ipa: "/pɔm/", audio: [] },
        },
      ],
      tags: ["starter", "tts-placeholder"],
    },
    {
      id: "fr-an-in-vent-vin",
      contrastId: "fr-an-in",
      terms: [
        {
          id: "fr-word-vent",
          phonemeId: "fr-an",
          word: { id: "fr-word-vent", written: "vent", ipa: "/vɑ̃/", audio: [] },
        },
        {
          id: "fr-word-vin",
          phonemeId: "fr-in",
          word: { id: "fr-word-vin", written: "vin", ipa: "/vɛ̃/", audio: [] },
        },
      ],
      tags: ["starter", "tts-placeholder", "nasal"],
    },
    {
      id: "fr-an-on-banc-bon",
      contrastId: "fr-an-on",
      terms: [
        {
          id: "fr-word-banc",
          phonemeId: "fr-an",
          word: { id: "fr-word-banc", written: "banc", ipa: "/bɑ̃/", audio: [] },
        },
        {
          id: "fr-word-bon",
          phonemeId: "fr-on",
          word: { id: "fr-word-bon", written: "bon", ipa: "/bɔ̃/", audio: [] },
        },
      ],
      tags: ["starter", "tts-placeholder", "nasal"],
    },
    {
      id: "fr-s-z-poisson-poison",
      contrastId: "fr-s-z",
      terms: [
        {
          id: "fr-word-poisson",
          phonemeId: "fr-s",
          word: { id: "fr-word-poisson", written: "poisson", ipa: "/pwasɔ̃/", audio: [] },
        },
        {
          id: "fr-word-poison",
          phonemeId: "fr-z",
          word: { id: "fr-word-poison", written: "poison", ipa: "/pwazɔ̃/", audio: [] },
        },
      ],
      tags: ["starter", "tts-placeholder"],
    },
    {
      id: "fr-sh-zh-chou-joue",
      contrastId: "fr-sh-zh",
      terms: [
        {
          id: "fr-word-chou",
          phonemeId: "fr-sh",
          word: { id: "fr-word-chou", written: "chou", ipa: "/ʃu/", audio: [] },
        },
        {
          id: "fr-word-joue",
          phonemeId: "fr-zh",
          word: { id: "fr-word-joue", written: "joue", ipa: "/ʒu/", audio: [] },
        },
      ],
      tags: ["starter", "tts-placeholder"],
    },
  ],
};
