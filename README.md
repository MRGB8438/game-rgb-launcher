# 🎮 Game RGB Launcher

> یه لانچر گیم رترو و مدرن که با عشق برای گیمرهای ایرانی ساخته شده ❤️
> A retro & modern game launcher built with ❤️ for gamers — especially Iranian ones.

---

# 🇮🇷 فارسی

یه لانچر همه‌کاره که هم بتونی بازی‌های رترو (NES، SNES، PS1 و...) رو اجرا کنی، هم بازی‌های ویندوزی خودت رو توش دسته‌بندی کنی، و هم یه پنل اخبار زنده از سایت‌های ایرانی داشته باشی.

## ✨ چی توشه؟

### 🕹️ پشتیبانی از ۱۳ کنسول رترو + ویندوز

بازی‌های این کنسول‌ها رو می‌تونی مستقیم توی خود لانچر اجرا کنی (با EmulatorJS که تو مرورگر اجرا میشه):

| کنسول | فرمت فایل‌ها |
|-------|-------------|
| 🎯 Nintendo NES | `.nes` |
| 🎯 Super Nintendo | `.sfc` `.smc` |
| 🎯 Game Boy / GBC / GBA | `.gb` `.gbc` `.gba` |
| 🎯 Nintendo 64 | `.n64` `.z64` |
| 🎯 Nintendo DS | `.nds` |
| 🎯 PlayStation 1 | `.pbp` `.chd` `.cue` `.bin` `.iso` |
| 🎯 PlayStation 2 | `.iso` `.bin` `.cue` (با شبیه‌ساز خارجی) |
| 🎯 Sega Genesis / Master System / Game Gear / 32X / CD | `.md` `.sms` `.gg` `.32x` `.iso` |
| 🎯 Atari 2600 / 7800 | `.a26` `.a78` |
| 🎯 Atari Lynx, PC Engine, Neo Geo Pocket, WonderSwan | … |
| 💻 Windows Games | `.exe` `.msi` `.bat` (مستقیم اجرا میشه) |

### 📰 پنل اخبار زنده گیم

آخرین اخبار بازی رو از **۵ سایت ایرانی** می‌خونه — بدون نیاز به VPN، با نت داخلی:

- 🟣 **ویدیاتو** — `vigiato.net`
- 🔵 **زومجی** — `zoomg.ir`
- 🔴 **گیم‌فا** — `gamefa.com`
- 🟠 **بازی‌سنتر** — `bazicenter.com`
- 🟢 **پارسی‌گیم** — `par30games.net`

هر سایت یه badge رنگی داره، اخبار بر اساس زمان sort میشن، و با کلیک روی هر خبر، تو مرورگر پیش‌فرضت باز میشه. اگه مسیر اصلی (پارس HTML) جواب نداد، خودکار میره سراغ RSS اون سایت.

### 🤖 دستیار هوش مصنوعی

یه چت‌بات داخلی داره که می‌تونی درباره بازی‌ها سوال بپرسی. این پروایدرها رو ساپورت می‌کنه:

- 🌐 **OpenRouter** — با یه کلید به GPT، Grok، Gemini، DeepSeek و Claude (مدل‌های `:free` کاملاً رایگان)
- 🔷 **Together AI** — مدل‌های متن‌باز با قیمت پایین
- 🎆 **Fireworks AI** — سرعت بالا
- 💎 **DeepSeek** — ارزون و باکیفیت
- ⚡ **Groq** — سریع‌ترین
- 🔮 **Gemini** — مستقیم از گوگل
- 🎯 و پروایدر کاستوم دلخواهت

با API Key خودت کار می‌کنه، کلیدها فقط توی سیستم خودت ذخیره میشن.

### 🎨 شخصی‌سازی فوق‌العاده

- 🌙☀️ دو تم اصلی: تاریک و روشن
- 🎨 ۱۲ فونت قابل انتخاب (فارسی: Vazirmatn، Baloo، Cairo، Lalezar، Markazi / انگلیسی: Chakra Petch، Orbitron، Rajdhani، Exo 2، Russo One / ژاپنی: ZCOOL، Noto Sans JP)
- 🎯 RGB accent color قابل تنظیم با slider
- 🌐 سه زبان: فارسی، انگلیسی، ژاپنی

### 🏆 سیستم دستاورد و پروفایل

- پروفایل گیمری شخصی با آمار بازی‌ها
- سیستم دستاورد برای انگیزه دادن به بازی
- آمار کلی کتابخانه: تعداد بازی، ساعت بازی، کنسول‌ها

### 🎵 پخش موسیقی پس‌زمینه

یه پلیر موسیقی داخلی داره که می‌تونی فایل MP3 خودت رو توش لود کنی و حین بازی گوش بدی. کاور آلبوم‌ها خودکار از iTunes API fetch میشه.

### ⌨️ تنظیم کلیدها

می‌تونی دکمه‌های کیبورد/گیم‌پد رو برای هر کنسول جداگانه رِمَپ کنی. پشتیبانی کامل از گیم‌پد.

### 💾 مدیریت چیت

برای کنسول‌های پشتیبانی‌شده می‌تونی کدهای GameShark / GameGenie اضافه کنی.

## 🚀 نصب و اجرا

۱. فایل نصبی `GameRGBLauncher.exe` رو از بخش [Releases](../../releases) دانلود کن.
۲. اجراش کن و مراحل نصب رو پیش ببر.
۳. از منوی استارت یا دسکتاپ، **Game RGB Launcher** رو باز کن.

تمام! لانچر آماده‌ست — فقط بازی‌هات رو اضافه کن و شروع کن به بازی.

> 💡 **نکته:** لانچر فقط مسیر فایل‌های ROM/EXE رو ذخیره می‌کنه. فایل‌های بازی خودت رو هرجا که دوست داری نگه دار، موقع افزودن به لانچر فقط مسیرش رو انتخاب کن. کاور بازی‌ها هم خودکار از SteamGridDB و iTunes fetch میشه.

## 🌍 زبان‌ها

- 🇮🇷 **فارسی** (پیش‌فرض، RTL)
- 🇬🇧 **English** (LTR)
- 🇯🇵 **日本語** (LTR)

## 🤝 مشارکت

اگه خواستی کمک کنی:

- 🐛 باگ پیدا کنی → issue باز کن
- 🎨 تم/فونت جدید بسازی → PR بزن
- 📰 سایت خبری ایرانی جدید اضافه کنی
- 🌐 زبان جدید ترجمه کنی
- 🎮 کنسول جدید اضافه کنی

## ⚖️ لایسنس

MIT License — هر کاری خواستی باهاش بکن، فقط کپی‌رایت رو نگه دار.

## 🙏 تشکر از

- [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) — موتور اجرای رترو
- [SteamGridDB](https://www.steamgriddb.com/) — کاور بازی‌ها
- [Vazirmatn](https://github.com/rastikerdar/vazirmatn-font) — فونت فارسی
- سایت‌های ایرانی: ویدیاتو، زومجی، گیم‌فا، بازی‌سنتر، پارسی‌گیم — بابت اخبار

---

# 🇬🇧 English

An all-in-one launcher that lets you play retro games (NES, SNES, PS1, …), organize your Windows games, and read live gaming news from Iranian sites.

## ✨ Features

### 🕹️ 13 Retro Consoles + Windows

Play games from these consoles directly inside the launcher (powered by EmulatorJS, runs in the browser):

| Console | File Formats |
|---------|--------------|
| 🎯 Nintendo NES | `.nes` |
| 🎯 Super Nintendo | `.sfc` `.smc` |
| 🎯 Game Boy / GBC / GBA | `.gb` `.gbc` `.gba` |
| 🎯 Nintendo 64 | `.n64` `.z64` |
| 🎯 Nintendo DS | `.nds` |
| 🎯 PlayStation 1 | `.pbp` `.chd` `.cue` `.bin` `.iso` |
| 🎯 PlayStation 2 | `.iso` `.bin` `.cue` (via external emulator) |
| 🎯 Sega Genesis / Master System / Game Gear / 32X / CD | `.md` `.sms` `.gg` `.32x` `.iso` |
| 🎯 Atari 2600 / 7800 | `.a26` `.a78` |
| 🎯 Atari Lynx, PC Engine, Neo Geo Pocket, WonderSwan | … |
| 💻 Windows Games | `.exe` `.msi` `.bat` (launched directly) |

### 📰 Live Gaming News Panel

Pulls the latest gaming news from **5 Iranian sites** — no VPN required, works with the local Iranian network:

- 🟣 **Vigiato** — `vigiato.net`
- 🔵 **Zoomg** — `zoomg.ir`
- 🔴 **GameFa** — `gamefa.com`
- 🟠 **BaziCenter** — `bazicenter.com`
- 🟢 **Par30Games** — `par30games.net`

Each site has its own colored badge, news items are sorted by date, and clicking any item opens it in your default browser. If the primary path (HTML scraping) fails, it automatically falls back to the site's RSS feed.

### 🤖 Built-in AI Assistant

A built-in chatbot lets you ask questions about games. Supports these providers:

- 🌐 **OpenRouter** — one key, access to GPT, Grok, Gemini, DeepSeek and Claude (the `:free` models are completely free)
- 🔷 **Together AI** — open-source models at low cost
- 🎆 **Fireworks AI** — high-speed inference
- 💎 **DeepSeek** — cheap and high-quality
- ⚡ **Groq** — fastest
- 🔮 **Gemini** — directly from Google
- 🎯 …or any custom OpenAI-compatible endpoint

Uses your own API keys — keys are stored only on your local system.

### 🎨 Customization Galore

- 🌙☀️ Two main themes: dark and light
- 🎨 12 selectable fonts (Persian: Vazirmatn, Baloo, Cairo, Lalezar, Markazi / English: Chakra Petch, Orbitron, Rajdhani, Exo 2, Russo One / Japanese: ZCOOL, Noto Sans JP)
- 🎯 Adjustable RGB accent color via slider
- 🌐 Three languages: Persian, English, Japanese

### 🏆 Achievements & Profile

- Personal gamer profile with per-game stats
- Achievement system to keep you motivated
- Library overview: total games, hours played, consoles

### 🎵 Background Music Player

A built-in music player lets you load your own MP3 files and listen while you play. Album covers are fetched automatically from the iTunes API.

### ⌨️ Key Remapping

Remap keyboard / gamepad buttons per console. Full gamepad support.

### 💾 Cheat Manager

Add GameShark / GameGenie codes for supported consoles.

## 🚀 Install & Run

1. Download the `GameRGBLauncher.exe` installer from the [Releases](../../releases) page.
2. Run it and follow the setup wizard.
3. Launch **Game RGB Launcher** from the Start menu or your desktop.

That's it — the launcher is ready. Just add your games and start playing.

> 💡 **Note:** The launcher only stores the **paths** to your ROM/EXE files. Keep your game files wherever you like; when adding a game, just pick its file path. Game covers are fetched automatically from SteamGridDB and iTunes.

## 🌍 Languages

- 🇮🇷 **Persian** (default, RTL)
- 🇬🇧 **English** (LTR)
- 🇯🇵 **日本語** (LTR)

## 🤝 Contributing

Any help is welcome:

- 🐛 Find a bug → open an issue
- 🎨 Build a new theme/font → send a PR
- 📰 Add a new Iranian news site
- 🌐 Translate to a new language
- 🎮 Add a new console

## ⚖️ License

MIT License — do whatever you want, just keep the copyright notice.

## 🙏 Thanks

- [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) — retro emulation engine
- [SteamGridDB](https://www.steamgriddb.com/) — game covers
- [Vazirmatn](https://github.com/rastikerdar/vazirmatn-font) — Persian font
- Iranian sites: Vigiato, Zoomg, GameFa, BaziCenter, Par30Games — for the news

---

<div align="center">

**ساخته شده با ❤️ برای گیمرهای ایرانی**
**Made with ❤️ for Iranian gamers**

اگه خوشت اومد، یه ⭐ به ریپو بزن! 🌟
If you like it, drop a ⭐ on the repo! 🌟

</div>
