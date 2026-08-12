# Introvert

A sleek, minimalist, distraction-free cross-platform client for [Extrovert](https://github.com/RedForged/extrovert) built with **Tauri v2**.

Introvert removes all social media noise — **no public feeds, no post timelines, no discovery algorithms, no likes/reposts** — and focuses purely on what matters:

1. **End-to-End Encrypted Direct Messages** (Signal-style Matrix Olm Double Ratchet)
2. **Rooms & Spaces** (Megolm Group E2EE Text Channels & WebRTC Voice Channels)
3. **Peer-to-Peer Calls** (1:1 & Group Audio/Video with real-time Voice Activity Detection and audio synthesizer)
4. **Clean Minimalist Profiles** (Avatar, Display Name, Username, Bio, and Online Presence)

---

## 🌟 Key Features

### 🔒 Cryptography & Security
- **Olm Double Ratchet DMs**: End-to-end encrypted 1:1 messaging between mutual followers with forward secrecy and post-compromise security.
- **Megolm Group E2EE**: Multi-member encrypted room text channels with automated Olm key exchange and session rotation on member join/leave.
- **Additional Security Mode**: Mutual opt-in device-local storage ($K_d$ encrypted) with server auto-deletion upon two-party receipt confirmation.
- **Cross-Device Recovery**: PBKDF2 (600k iterations) password-derived key encryption for secure server key backups.
- **Safety Number Verification**: Visual fingerprint comparison to verify encryption integrity.

### 🔊 Voice & Video Calling (WebRTC)
- **1:1 Audio & Video Calls**: Peer-to-peer WebRTC calls between mutual contacts.
- **Spatial Room Voice Channels**: Multi-peer audio mesh for group conversations.
- **Voice Activity Detection (VAD)**: Real-time Web Audio API frequency analysis powering animated speaking rings around user avatars.
- **Built-in Audio Synthesizer**: Clean synthesized tones for ringback, incoming calls, connection chimes, join/leave blips, and call termination.
- **Floating Call Stage & Screen Sharing**: Minimize call to a floating widget to keep chatting while talking.

### 🎨 Clean Minimalist Obsidian UI
- Obsidian dark glassmorphic design system with responsive 3-pane to 1-pane transitions.
- Theme engine: Obsidian Dark, Cyber Emerald, Electric Indigo, OLED Pitch Black, Clean Light.
- Native safe-area inset support for mobile screens (iOS & Android).

---

## 🚀 Getting Started

### Prerequisites
- Node.js >= 18
- Rust >= 1.77 (`rustc`, `cargo`)
- Extrovert instance (running locally on `http://localhost:3000` or remote instance)

### Installation & Development

```bash
# 1. Install dependencies
npm install

# 2. Run verification tests
npm test

# 3. Run development webview server
npm run dev

# 4. Run native desktop application (Tauri)
npm run tauri dev
```

---

## 📦 Cross-Platform Build Targets

Introvert is built with **Tauri v2** and compiles natively for all platforms:

### Desktop

```bash
# macOS (Apple Silicon arm64 & Intel x86_64)
npm run tauri build

# Linux (AppImage / deb / rpm)
npm run tauri build

# Windows (MSI / exe)
npm run tauri build
```

### Mobile

```bash
# Android
npm run tauri android init
npm run tauri android dev
npm run tauri android build

# iOS
npm run tauri ios init
npm run tauri ios dev
npm run tauri ios build
```

---

## 🏗️ Architecture

```
introvert/
├── src/
│   ├── core/
│   │   ├── api.js         # Extrovert REST API client (Auth, DMs, Rooms, Profiles, Media)
│   │   ├── crypto.js      # Matrix Olm & Megolm Double-Ratchet engine
│   │   ├── signaling.js   # WebSocket client for /ws (presence, calls, live DMs)
│   │   ├── webrtc.js      # WebRTC peer mesh, VAD speaking detection & tone synthesizer
│   │   ├── state.js       # Reactive state stores (Auth, Chats, Rooms, Calls, Presence)
│   │   └── config.js      # Multi-instance settings & native storage bridge
│   ├── ui/
│   │   ├── components/    # Navigation, ChatList, ChatView, RoomList, RoomView, CallOverlay, ProfileModal, SettingsModal
│   │   └── styles/        # Obsidian design system CSS tokens & animations
│   └── main.js            # Application bootstrapping & route orchestrator
├── src-tauri/             # Tauri v2 Rust native layer (storage bridge & permissions)
├── public/
│   ├── lib/               # Matrix Olm WebAssembly runtime (olm.js, olm.wasm)
│   └── icons/             # Multi-resolution app & platform icons
└── scripts/
    └── test-introvert.js  # Automated protocol & cryptographic regression suite
```

---

## 📄 License
GPL-3.0-or-later — Free and Open Source.
