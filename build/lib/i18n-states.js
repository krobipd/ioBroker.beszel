"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var i18n_states_exports = {};
__export(i18n_states_exports, {
  STATE_NAMES: () => STATE_NAMES,
  tName: () => tName
});
module.exports = __toCommonJS(i18n_states_exports);
const STATE_NAMES = {
  // ──────── instanceObjects names (v0.5.0 B1+B3) ────────
  /** `info.connection` state name (was hardcoded en in io-package.json). */
  connectionStatus: {
    en: "Connection status",
    de: "Verbindungsstatus",
    ru: "\u0421\u0442\u0430\u0442\u0443\u0441 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F",
    pt: "Estado da liga\xE7\xE3o",
    nl: "Verbindingsstatus",
    fr: "\xC9tat de la connexion",
    it: "Stato connessione",
    es: "Estado de conexi\xF3n",
    pl: "Stan po\u0142\u0105czenia",
    uk: "\u0421\u0442\u0430\u043D \u0437'\u0454\u0434\u043D\u0430\u043D\u043D\u044F",
    "zh-cn": "\u8FDE\u63A5\u72B6\u6001"
  },
  /** `systems` folder name (was inline 11-lang object in io-package.json). */
  channelSystems: {
    en: "Monitored Systems",
    de: "\xDCberwachte Systeme",
    ru: "\u041E\u0442\u0441\u043B\u0435\u0436\u0438\u0432\u0430\u0435\u043C\u044B\u0435 \u0441\u0438\u0441\u0442\u0435\u043C\u044B",
    pt: "Sistemas monitorizados",
    nl: "Gecontroleerde systemen",
    fr: "Syst\xE8mes surveill\xE9s",
    it: "Sistemi monitorati",
    es: "Sistemas monitorizados",
    pl: "Monitorowane systemy",
    uk: "\u0412\u0456\u0434\u0441\u0442\u0435\u0436\u0443\u0432\u0430\u043D\u0456 \u0441\u0438\u0441\u0442\u0435\u043C\u0438",
    "zh-cn": "\u53D7\u76D1\u63A7\u7684\u7CFB\u7EDF"
  },
  // ──────── Channel names ────────
  channelInfo: {
    en: "Info",
    de: "Info",
    ru: "\u0418\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F",
    pt: "Informa\xE7\xE3o",
    nl: "Info",
    fr: "Infos",
    it: "Info",
    es: "Informaci\xF3n",
    pl: "Info",
    uk: "\u0406\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0456\u044F",
    "zh-cn": "\u4FE1\u606F"
  },
  channelCpu: {
    en: "CPU",
    de: "CPU",
    ru: "CPU",
    pt: "CPU",
    nl: "CPU",
    fr: "CPU",
    it: "CPU",
    es: "CPU",
    pl: "CPU",
    uk: "CPU",
    "zh-cn": "CPU"
  },
  channelMemory: {
    en: "Memory",
    de: "Speicher",
    ru: "\u041F\u0430\u043C\u044F\u0442\u044C",
    pt: "Mem\xF3ria",
    nl: "Geheugen",
    fr: "M\xE9moire",
    it: "Memoria",
    es: "Memoria",
    pl: "Pami\u0119\u0107",
    uk: "\u041F\u0430\u043C'\u044F\u0442\u044C",
    "zh-cn": "\u5185\u5B58"
  },
  channelDisk: {
    en: "Disk",
    de: "Festplatte",
    ru: "\u0414\u0438\u0441\u043A",
    pt: "Disco",
    nl: "Schijf",
    fr: "Disque",
    it: "Disco",
    es: "Disco",
    pl: "Dysk",
    uk: "\u0414\u0438\u0441\u043A",
    "zh-cn": "\u78C1\u76D8"
  },
  channelNetwork: {
    en: "Network",
    de: "Netzwerk",
    ru: "\u0421\u0435\u0442\u044C",
    pt: "Rede",
    nl: "Netwerk",
    fr: "R\xE9seau",
    it: "Rete",
    es: "Red",
    pl: "Sie\u0107",
    uk: "\u041C\u0435\u0440\u0435\u0436\u0430",
    "zh-cn": "\u7F51\u7EDC"
  },
  channelTemperature: {
    en: "Temperature",
    de: "Temperatur",
    ru: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430",
    pt: "Temperatura",
    nl: "Temperatuur",
    fr: "Temp\xE9rature",
    it: "Temperatura",
    es: "Temperatura",
    pl: "Temperatura",
    uk: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430",
    "zh-cn": "\u6E29\u5EA6"
  },
  channelSensors: {
    en: "Sensors",
    de: "Sensoren",
    ru: "\u0414\u0430\u0442\u0447\u0438\u043A\u0438",
    pt: "Sensores",
    nl: "Sensoren",
    fr: "Capteurs",
    it: "Sensori",
    es: "Sensores",
    pl: "Czujniki",
    uk: "\u0414\u0430\u0442\u0447\u0438\u043A\u0438",
    "zh-cn": "\u4F20\u611F\u5668"
  },
  channelBattery: {
    en: "Battery",
    de: "Akku",
    ru: "\u0411\u0430\u0442\u0430\u0440\u0435\u044F",
    pt: "Bateria",
    nl: "Accu",
    fr: "Batterie",
    it: "Batteria",
    es: "Bater\xEDa",
    pl: "Bateria",
    uk: "\u0411\u0430\u0442\u0430\u0440\u0435\u044F",
    "zh-cn": "\u7535\u6C60"
  },
  channelGpu: {
    en: "GPU",
    de: "GPU",
    ru: "GPU",
    pt: "GPU",
    nl: "GPU",
    fr: "GPU",
    it: "GPU",
    es: "GPU",
    pl: "GPU",
    uk: "GPU",
    "zh-cn": "GPU"
  },
  channelFilesystems: {
    en: "Filesystems",
    de: "Dateisysteme",
    ru: "\u0424\u0430\u0439\u043B\u043E\u0432\u044B\u0435 \u0441\u0438\u0441\u0442\u0435\u043C\u044B",
    pt: "Sistemas de ficheiros",
    nl: "Bestandssystemen",
    fr: "Syst\xE8mes de fichiers",
    it: "Filesystem",
    es: "Sistemas de archivos",
    pl: "Systemy plik\xF3w",
    uk: "\u0424\u0430\u0439\u043B\u043E\u0432\u0456 \u0441\u0438\u0441\u0442\u0435\u043C\u0438",
    "zh-cn": "\u6587\u4EF6\u7CFB\u7EDF"
  },
  channelContainers: {
    en: "Containers",
    de: "Container",
    ru: "\u041A\u043E\u043D\u0442\u0435\u0439\u043D\u0435\u0440\u044B",
    pt: "Contentores",
    nl: "Containers",
    fr: "Conteneurs",
    it: "Container",
    es: "Contenedores",
    pl: "Kontenery",
    uk: "\u041A\u043E\u043D\u0442\u0435\u0439\u043D\u0435\u0440\u0438",
    "zh-cn": "\u5BB9\u5668"
  },
  // ──────── Info states ────────
  online: {
    en: "Online",
    de: "Online",
    ru: "\u041E\u043D\u043B\u0430\u0439\u043D",
    pt: "Online",
    nl: "Online",
    fr: "En ligne",
    it: "Online",
    es: "En l\xEDnea",
    pl: "Online",
    uk: "\u041E\u043D\u043B\u0430\u0439\u043D",
    "zh-cn": "\u5728\u7EBF"
  },
  status: {
    en: "Status",
    de: "Status",
    ru: "\u0421\u0442\u0430\u0442\u0443\u0441",
    pt: "Estado",
    nl: "Status",
    fr: "\xC9tat",
    it: "Stato",
    es: "Estado",
    pl: "Status",
    uk: "\u0421\u0442\u0430\u0442\u0443\u0441",
    "zh-cn": "\u72B6\u6001"
  },
  uptime: {
    en: "Uptime",
    de: "Betriebszeit",
    ru: "\u0412\u0440\u0435\u043C\u044F \u0440\u0430\u0431\u043E\u0442\u044B",
    pt: "Tempo ativo",
    nl: "Uptime",
    fr: "Temps de fonctionnement",
    it: "Tempo di attivit\xE0",
    es: "Tiempo activo",
    pl: "Czas pracy",
    uk: "\u0427\u0430\u0441 \u0440\u043E\u0431\u043E\u0442\u0438",
    "zh-cn": "\u8FD0\u884C\u65F6\u95F4"
  },
  uptimeFormatted: {
    en: "Uptime (formatted)",
    de: "Betriebszeit (formatiert)",
    ru: "\u0412\u0440\u0435\u043C\u044F \u0440\u0430\u0431\u043E\u0442\u044B (\u0444\u043E\u0440\u043C\u0430\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u043E\u0435)",
    pt: "Tempo ativo (formatado)",
    nl: "Uptime (geformatteerd)",
    fr: "Temps de fonctionnement (format\xE9)",
    it: "Tempo di attivit\xE0 (formattato)",
    es: "Tiempo activo (formateado)",
    pl: "Czas pracy (formatowany)",
    uk: "\u0427\u0430\u0441 \u0440\u043E\u0431\u043E\u0442\u0438 (\u0444\u043E\u0440\u043C\u0430\u0442\u043E\u0432\u0430\u043D\u0438\u0439)",
    "zh-cn": "\u8FD0\u884C\u65F6\u95F4\uFF08\u683C\u5F0F\u5316\uFF09"
  },
  agentVersion: {
    en: "Agent Version",
    de: "Agent-Version",
    ru: "\u0412\u0435\u0440\u0441\u0438\u044F Agent",
    pt: "Vers\xE3o do Agent",
    nl: "Agent-versie",
    fr: "Version de l'Agent",
    it: "Versione Agent",
    es: "Versi\xF3n del Agent",
    pl: "Wersja Agenta",
    uk: "\u0412\u0435\u0440\u0441\u0456\u044F Agent",
    "zh-cn": "Agent \u7248\u672C"
  },
  servicesTotal: {
    en: "Services Total",
    de: "Dienste gesamt",
    ru: "\u0412\u0441\u0435\u0433\u043E \u0441\u043B\u0443\u0436\u0431",
    pt: "Total de servi\xE7os",
    nl: "Diensten totaal",
    fr: "Services au total",
    it: "Servizi totali",
    es: "Servicios totales",
    pl: "Us\u0142ugi \u0142\u0105cznie",
    uk: "\u0423\u0441\u044C\u043E\u0433\u043E \u0441\u043B\u0443\u0436\u0431",
    "zh-cn": "\u670D\u52A1\u603B\u6570"
  },
  servicesFailed: {
    en: "Services Failed",
    de: "Dienste fehlgeschlagen",
    ru: "\u041E\u0448\u0438\u0431\u043A\u0438 \u0441\u043B\u0443\u0436\u0431",
    pt: "Servi\xE7os falhados",
    nl: "Diensten mislukt",
    fr: "Services en \xE9chec",
    it: "Servizi falliti",
    es: "Servicios fallidos",
    pl: "Us\u0142ugi nieudane",
    uk: "\u0421\u043B\u0443\u0436\u0431\u0438 \u0437 \u043F\u043E\u043C\u0438\u043B\u043A\u043E\u044E",
    "zh-cn": "\u5931\u8D25\u7684\u670D\u52A1"
  },
  // ──────── CPU states ────────
  cpuUsage: {
    en: "CPU Usage",
    de: "CPU-Auslastung",
    ru: "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 CPU",
    pt: "Uso de CPU",
    nl: "CPU-belasting",
    fr: "Utilisation CPU",
    it: "Utilizzo CPU",
    es: "Uso de CPU",
    pl: "Wykorzystanie CPU",
    uk: "\u0417\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F CPU",
    "zh-cn": "CPU \u4F7F\u7528\u7387"
  },
  cpuUser: {
    en: "CPU User %",
    de: "CPU User %",
    ru: "CPU User %",
    pt: "CPU Utilizador %",
    nl: "CPU User %",
    fr: "CPU User %",
    it: "CPU User %",
    es: "CPU Usuario %",
    pl: "CPU User %",
    uk: "CPU User %",
    "zh-cn": "CPU \u7528\u6237\u6001 %"
  },
  cpuSystem: {
    en: "CPU System %",
    de: "CPU System %",
    ru: "CPU System %",
    pt: "CPU Sistema %",
    nl: "CPU System %",
    fr: "CPU Syst\xE8me %",
    it: "CPU System %",
    es: "CPU Sistema %",
    pl: "CPU System %",
    uk: "CPU System %",
    "zh-cn": "CPU \u5185\u6838\u6001 %"
  },
  cpuIowait: {
    en: "CPU IOWait %",
    de: "CPU IOWait %",
    ru: "CPU IOWait %",
    pt: "CPU IOWait %",
    nl: "CPU IOWait %",
    fr: "CPU IOWait %",
    it: "CPU IOWait %",
    es: "CPU IOWait %",
    pl: "CPU IOWait %",
    uk: "CPU IOWait %",
    "zh-cn": "CPU IOWait %"
  },
  cpuSteal: {
    en: "CPU Steal %",
    de: "CPU Steal %",
    ru: "CPU Steal %",
    pt: "CPU Steal %",
    nl: "CPU Steal %",
    fr: "CPU Steal %",
    it: "CPU Steal %",
    es: "CPU Steal %",
    pl: "CPU Steal %",
    uk: "CPU Steal %",
    "zh-cn": "CPU Steal %"
  },
  cpuIdle: {
    en: "CPU Idle %",
    de: "CPU Idle %",
    ru: "CPU Idle %",
    pt: "CPU Idle %",
    nl: "CPU Idle %",
    fr: "CPU Idle %",
    it: "CPU Idle %",
    es: "CPU Idle %",
    pl: "CPU Idle %",
    uk: "CPU Idle %",
    "zh-cn": "CPU \u7A7A\u95F2 %"
  },
  load1m: {
    en: "Load Average 1m",
    de: "Load Average 1m",
    ru: "Load Average 1\u043C",
    pt: "Load Average 1m",
    nl: "Load Average 1m",
    fr: "Charge moyenne 1m",
    it: "Carico medio 1m",
    es: "Carga media 1m",
    pl: "Load Average 1m",
    uk: "Load Average 1\u0445\u0432",
    "zh-cn": "1 \u5206\u949F\u8D1F\u8F7D"
  },
  load5m: {
    en: "Load Average 5m",
    de: "Load Average 5m",
    ru: "Load Average 5\u043C",
    pt: "Load Average 5m",
    nl: "Load Average 5m",
    fr: "Charge moyenne 5m",
    it: "Carico medio 5m",
    es: "Carga media 5m",
    pl: "Load Average 5m",
    uk: "Load Average 5\u0445\u0432",
    "zh-cn": "5 \u5206\u949F\u8D1F\u8F7D"
  },
  load15m: {
    en: "Load Average 15m",
    de: "Load Average 15m",
    ru: "Load Average 15\u043C",
    pt: "Load Average 15m",
    nl: "Load Average 15m",
    fr: "Charge moyenne 15m",
    it: "Carico medio 15m",
    es: "Carga media 15m",
    pl: "Load Average 15m",
    uk: "Load Average 15\u0445\u0432",
    "zh-cn": "15 \u5206\u949F\u8D1F\u8F7D"
  },
  // ──────── Memory states ────────
  memoryPercent: {
    en: "Memory %",
    de: "Speicher %",
    ru: "\u041F\u0430\u043C\u044F\u0442\u044C %",
    pt: "Mem\xF3ria %",
    nl: "Geheugen %",
    fr: "M\xE9moire %",
    it: "Memoria %",
    es: "Memoria %",
    pl: "Pami\u0119\u0107 %",
    uk: "\u041F\u0430\u043C'\u044F\u0442\u044C %",
    "zh-cn": "\u5185\u5B58\u4F7F\u7528\u7387"
  },
  memoryUsed: {
    en: "Memory Used",
    de: "Speicher belegt",
    ru: "\u041F\u0430\u043C\u044F\u0442\u044C \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043E",
    pt: "Mem\xF3ria usada",
    nl: "Geheugen gebruikt",
    fr: "M\xE9moire utilis\xE9e",
    it: "Memoria usata",
    es: "Memoria usada",
    pl: "Pami\u0119\u0107 u\u017Cyta",
    uk: "\u041F\u0430\u043C'\u044F\u0442\u044C \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u043D\u043E",
    "zh-cn": "\u5DF2\u7528\u5185\u5B58"
  },
  memoryTotal: {
    en: "Memory Total",
    de: "Speicher gesamt",
    ru: "\u041F\u0430\u043C\u044F\u0442\u044C \u0432\u0441\u0435\u0433\u043E",
    pt: "Mem\xF3ria total",
    nl: "Geheugen totaal",
    fr: "M\xE9moire totale",
    it: "Memoria totale",
    es: "Memoria total",
    pl: "Pami\u0119\u0107 \u0142\u0105cznie",
    uk: "\u041F\u0430\u043C'\u044F\u0442\u044C \u0443\u0441\u044C\u043E\u0433\u043E",
    "zh-cn": "\u603B\u5185\u5B58"
  },
  memoryBuffers: {
    en: "Memory Buffers+Cache",
    de: "Speicher Buffers+Cache",
    ru: "\u041F\u0430\u043C\u044F\u0442\u044C Buffers+Cache",
    pt: "Mem\xF3ria Buffers+Cache",
    nl: "Geheugen Buffers+Cache",
    fr: "M\xE9moire Buffers+Cache",
    it: "Memoria Buffers+Cache",
    es: "Memoria Buffers+Cache",
    pl: "Pami\u0119\u0107 Buffers+Cache",
    uk: "\u041F\u0430\u043C'\u044F\u0442\u044C Buffers+Cache",
    "zh-cn": "Buffers+Cache \u5185\u5B58"
  },
  memoryZfsArc: {
    en: "Memory ZFS ARC",
    de: "Speicher ZFS ARC",
    ru: "\u041F\u0430\u043C\u044F\u0442\u044C ZFS ARC",
    pt: "Mem\xF3ria ZFS ARC",
    nl: "Geheugen ZFS ARC",
    fr: "M\xE9moire ZFS ARC",
    it: "Memoria ZFS ARC",
    es: "Memoria ZFS ARC",
    pl: "Pami\u0119\u0107 ZFS ARC",
    uk: "\u041F\u0430\u043C'\u044F\u0442\u044C ZFS ARC",
    "zh-cn": "ZFS ARC \u5185\u5B58"
  },
  swapUsed: {
    en: "Swap Used",
    de: "Swap belegt",
    ru: "Swap \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043E",
    pt: "Swap usado",
    nl: "Swap gebruikt",
    fr: "Swap utilis\xE9",
    it: "Swap usato",
    es: "Swap usado",
    pl: "Swap u\u017Cyty",
    uk: "Swap \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u043D\u043E",
    "zh-cn": "\u5DF2\u7528 Swap"
  },
  swapTotal: {
    en: "Swap Total",
    de: "Swap gesamt",
    ru: "Swap \u0432\u0441\u0435\u0433\u043E",
    pt: "Swap total",
    nl: "Swap totaal",
    fr: "Swap total",
    it: "Swap totale",
    es: "Swap total",
    pl: "Swap \u0142\u0105cznie",
    uk: "Swap \u0443\u0441\u044C\u043E\u0433\u043E",
    "zh-cn": "\u603B Swap"
  },
  // ──────── Disk states ────────
  diskPercent: {
    en: "Disk %",
    de: "Festplatte %",
    ru: "\u0414\u0438\u0441\u043A %",
    pt: "Disco %",
    nl: "Schijf %",
    fr: "Disque %",
    it: "Disco %",
    es: "Disco %",
    pl: "Dysk %",
    uk: "\u0414\u0438\u0441\u043A %",
    "zh-cn": "\u78C1\u76D8\u4F7F\u7528\u7387"
  },
  diskUsed: {
    en: "Disk Used",
    de: "Festplatte belegt",
    ru: "\u0414\u0438\u0441\u043A \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043E",
    pt: "Disco usado",
    nl: "Schijf gebruikt",
    fr: "Disque utilis\xE9",
    it: "Disco usato",
    es: "Disco usado",
    pl: "Dysk u\u017Cyty",
    uk: "\u0414\u0438\u0441\u043A \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u043D\u043E",
    "zh-cn": "\u5DF2\u7528\u78C1\u76D8"
  },
  diskTotal: {
    en: "Disk Total",
    de: "Festplatte gesamt",
    ru: "\u0414\u0438\u0441\u043A \u0432\u0441\u0435\u0433\u043E",
    pt: "Disco total",
    nl: "Schijf totaal",
    fr: "Disque total",
    it: "Disco totale",
    es: "Disco total",
    pl: "Dysk \u0142\u0105cznie",
    uk: "\u0414\u0438\u0441\u043A \u0443\u0441\u044C\u043E\u0433\u043E",
    "zh-cn": "\u603B\u78C1\u76D8"
  },
  diskRead: {
    en: "Disk Read",
    de: "Festplatte Lesen",
    ru: "\u0414\u0438\u0441\u043A \u0447\u0442\u0435\u043D\u0438\u0435",
    pt: "Disco leitura",
    nl: "Schijf lezen",
    fr: "Disque Lecture",
    it: "Disco Lettura",
    es: "Disco lectura",
    pl: "Dysk odczyt",
    uk: "\u0414\u0438\u0441\u043A \u0447\u0438\u0442\u0430\u043D\u043D\u044F",
    "zh-cn": "\u78C1\u76D8\u8BFB\u53D6"
  },
  diskWrite: {
    en: "Disk Write",
    de: "Festplatte Schreiben",
    ru: "\u0414\u0438\u0441\u043A \u0437\u0430\u043F\u0438\u0441\u044C",
    pt: "Disco escrita",
    nl: "Schijf schrijven",
    fr: "Disque \xC9criture",
    it: "Disco Scrittura",
    es: "Disco escritura",
    pl: "Dysk zapis",
    uk: "\u0414\u0438\u0441\u043A \u0437\u0430\u043F\u0438\u0441",
    "zh-cn": "\u78C1\u76D8\u5199\u5165"
  },
  readSpeed: {
    en: "Read Speed",
    de: "Lesegeschwindigkeit",
    ru: "\u0421\u043A\u043E\u0440\u043E\u0441\u0442\u044C \u0447\u0442\u0435\u043D\u0438\u044F",
    pt: "Velocidade de leitura",
    nl: "Leessnelheid",
    fr: "Vitesse de lecture",
    it: "Velocit\xE0 di lettura",
    es: "Velocidad de lectura",
    pl: "Pr\u0119dko\u015B\u0107 odczytu",
    uk: "\u0428\u0432\u0438\u0434\u043A\u0456\u0441\u0442\u044C \u0447\u0438\u0442\u0430\u043D\u043D\u044F",
    "zh-cn": "\u8BFB\u53D6\u901F\u5EA6"
  },
  writeSpeed: {
    en: "Write Speed",
    de: "Schreibgeschwindigkeit",
    ru: "\u0421\u043A\u043E\u0440\u043E\u0441\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u0438",
    pt: "Velocidade de escrita",
    nl: "Schrijfsnelheid",
    fr: "Vitesse d'\xE9criture",
    it: "Velocit\xE0 di scrittura",
    es: "Velocidad de escritura",
    pl: "Pr\u0119dko\u015B\u0107 zapisu",
    uk: "\u0428\u0432\u0438\u0434\u043A\u0456\u0441\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u0443",
    "zh-cn": "\u5199\u5165\u901F\u5EA6"
  },
  // ──────── Network states ────────
  networkSent: {
    en: "Network Sent",
    de: "Netzwerk gesendet",
    ru: "\u0421\u0435\u0442\u044C \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E",
    pt: "Rede enviado",
    nl: "Netwerk verzonden",
    fr: "R\xE9seau envoy\xE9",
    it: "Rete inviato",
    es: "Red enviado",
    pl: "Sie\u0107 wys\u0142ano",
    uk: "\u041C\u0435\u0440\u0435\u0436\u0430 \u043D\u0430\u0434\u0456\u0441\u043B\u0430\u043D\u043E",
    "zh-cn": "\u7F51\u7EDC\u53D1\u9001"
  },
  networkReceived: {
    en: "Network Received",
    de: "Netzwerk empfangen",
    ru: "\u0421\u0435\u0442\u044C \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E",
    pt: "Rede recebido",
    nl: "Netwerk ontvangen",
    fr: "R\xE9seau re\xE7u",
    it: "Rete ricevuto",
    es: "Red recibido",
    pl: "Sie\u0107 odebrano",
    uk: "\u041C\u0435\u0440\u0435\u0436\u0430 \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E",
    "zh-cn": "\u7F51\u7EDC\u63A5\u6536"
  },
  // ──────── Temperature ────────
  temperatureAvg: {
    en: "Temperature (avg top 3)",
    de: "Temperatur (\xD8 Top 3)",
    ru: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430 (\u0441\u0440\u0435\u0434\u043D\u0435\u0435 \u0442\u043E\u043F-3)",
    pt: "Temperatura (m\xE9dia top 3)",
    nl: "Temperatuur (gem. top 3)",
    fr: "Temp\xE9rature (moy. top 3)",
    it: "Temperatura (media top 3)",
    es: "Temperatura (media top 3)",
    pl: "Temperatura (\u015Br. top 3)",
    uk: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430 (\u0441\u0435\u0440. \u0442\u043E\u043F-3)",
    "zh-cn": "\u6E29\u5EA6\uFF08\u524D 3 \u5E73\u5747\uFF09"
  },
  // ──────── Battery ────────
  batteryPercent: {
    en: "Battery %",
    de: "Akku %",
    ru: "\u0411\u0430\u0442\u0430\u0440\u0435\u044F %",
    pt: "Bateria %",
    nl: "Accu %",
    fr: "Batterie %",
    it: "Batteria %",
    es: "Bater\xEDa %",
    pl: "Bateria %",
    uk: "\u0411\u0430\u0442\u0430\u0440\u0435\u044F %",
    "zh-cn": "\u7535\u6C60 %"
  },
  batteryCharging: {
    en: "Battery Charging",
    de: "Akku l\xE4dt",
    ru: "\u0411\u0430\u0442\u0430\u0440\u0435\u044F \u0437\u0430\u0440\u044F\u0436\u0430\u0435\u0442\u0441\u044F",
    pt: "Bateria a carregar",
    nl: "Accu laadt",
    fr: "Batterie en charge",
    it: "Batteria in carica",
    es: "Bater\xEDa cargando",
    pl: "Bateria \u0142aduje si\u0119",
    uk: "\u0411\u0430\u0442\u0430\u0440\u0435\u044F \u0437\u0430\u0440\u044F\u0434\u0436\u0430\u0454\u0442\u044C\u0441\u044F",
    "zh-cn": "\u7535\u6C60\u5145\u7535\u4E2D"
  },
  // ──────── GPU ────────
  gpuUsage: {
    en: "GPU Usage",
    de: "GPU-Auslastung",
    ru: "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 GPU",
    pt: "Uso de GPU",
    nl: "GPU-belasting",
    fr: "Utilisation GPU",
    it: "Utilizzo GPU",
    es: "Uso de GPU",
    pl: "Wykorzystanie GPU",
    uk: "\u0417\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F GPU",
    "zh-cn": "GPU \u4F7F\u7528\u7387"
  },
  gpuMemoryUsed: {
    en: "GPU Memory Used",
    de: "GPU-Speicher belegt",
    ru: "GPU \u043F\u0430\u043C\u044F\u0442\u044C \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043E",
    pt: "Mem\xF3ria GPU usada",
    nl: "GPU-geheugen gebruikt",
    fr: "M\xE9moire GPU utilis\xE9e",
    it: "Memoria GPU usata",
    es: "Memoria GPU usada",
    pl: "Pami\u0119\u0107 GPU u\u017Cyta",
    uk: "\u041F\u0430\u043C'\u044F\u0442\u044C GPU \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u043D\u043E",
    "zh-cn": "\u5DF2\u7528 GPU \u5185\u5B58"
  },
  gpuMemoryTotal: {
    en: "GPU Memory Total",
    de: "GPU-Speicher gesamt",
    ru: "GPU \u043F\u0430\u043C\u044F\u0442\u044C \u0432\u0441\u0435\u0433\u043E",
    pt: "Mem\xF3ria GPU total",
    nl: "GPU-geheugen totaal",
    fr: "M\xE9moire GPU totale",
    it: "Memoria GPU totale",
    es: "Memoria GPU total",
    pl: "Pami\u0119\u0107 GPU \u0142\u0105cznie",
    uk: "\u041F\u0430\u043C'\u044F\u0442\u044C GPU \u0443\u0441\u044C\u043E\u0433\u043E",
    "zh-cn": "\u603B GPU \u5185\u5B58"
  },
  gpuPower: {
    en: "GPU Power",
    de: "GPU Leistung",
    ru: "GPU \u043F\u043E\u0442\u0440\u0435\u0431\u043B\u0435\u043D\u0438\u0435",
    pt: "Pot\xEAncia GPU",
    nl: "GPU-vermogen",
    fr: "Puissance GPU",
    it: "Potenza GPU",
    es: "Potencia GPU",
    pl: "Moc GPU",
    uk: "\u041F\u043E\u0442\u0443\u0436\u043D\u0456\u0441\u0442\u044C GPU",
    "zh-cn": "GPU \u529F\u8017"
  },
  // ──────── Container states ────────
  containerHealth: {
    en: "Health",
    de: "Health",
    ru: "Health",
    pt: "Sa\xFAde",
    nl: "Health",
    fr: "Sant\xE9",
    it: "Salute",
    es: "Salud",
    pl: "Health",
    uk: "\u0421\u0442\u0430\u043D \u0437\u0434\u043E\u0440\u043E\u0432'\u044F",
    "zh-cn": "\u5065\u5EB7\u72B6\u6001"
  },
  containerImage: {
    en: "Image",
    de: "Image",
    ru: "\u041E\u0431\u0440\u0430\u0437",
    pt: "Imagem",
    nl: "Image",
    fr: "Image",
    it: "Immagine",
    es: "Imagen",
    pl: "Obraz",
    uk: "\u041E\u0431\u0440\u0430\u0437",
    "zh-cn": "\u955C\u50CF"
  },
  containerMemory: {
    en: "Memory",
    de: "Speicher",
    ru: "\u041F\u0430\u043C\u044F\u0442\u044C",
    pt: "Mem\xF3ria",
    nl: "Geheugen",
    fr: "M\xE9moire",
    it: "Memoria",
    es: "Memoria",
    pl: "Pami\u0119\u0107",
    uk: "\u041F\u0430\u043C'\u044F\u0442\u044C",
    "zh-cn": "\u5185\u5B58"
  }
};
function tName(key) {
  return STATE_NAMES[key];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  STATE_NAMES,
  tName
});
//# sourceMappingURL=i18n-states.js.map
