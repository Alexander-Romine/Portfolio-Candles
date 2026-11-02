'use strict';

/* -------------------------------------------------------------------------
   New York (US equity market) time helpers — exposed as window.ET
   ---------------------------------------------------------------------- */
(function defineET() {
  const TZ = 'America/New_York';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const cache = new Map();

  function fmt(opts) {
    const key = JSON.stringify(opts);
    if (!cache.has(key)) {
      cache.set(key, new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }));
    }
    return cache.get(key);
  }

  function parts(ms) {
    const arr = fmt({
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short', hour12: false
    }).formatToParts(new Date(ms));
    const num = (type) => Number(arr.find((p) => p.type === type)?.value);
    let hour = num('hour');
    if (hour === 24) hour = 0;
    return {
      year: num('year'), month: num('month'), day: num('day'),
      hour, minute: num('minute'), second: num('second'),
      weekday: arr.find((p) => p.type === 'weekday')?.value || ''
    };
  }

  function dateStr(ms) {
    const p = parts(ms);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }

  function isWeekend(ms) {
    const w = parts(ms).weekday;
    return w === 'Sat' || w === 'Sun';
  }

  // Regular trading hours: Mon-Fri 09:30 - 16:00 ET
  function isOpen(ms) {
    if (isWeekend(ms)) return false;
    const p = parts(ms);
    const mins = p.hour * 60 + p.minute;
    return mins >= 570 && mins < 960;
  }

  function clockStr(ms) {
    const p = parts(ms);
    const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
    const ampm = p.hour < 12 ? 'AM' : 'PM';
    return `${h12}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')} ${ampm} ET`;
  }

  window.ET = { MONTHS, parts, dateStr, isWeekend, isOpen, clockStr };
})();

/* -------------------------------------------------------------------------
   Candlestick chart built on TradingView Lightweight Charts
   ---------------------------------------------------------------------- */
window.ChartPane = (function () {
  const LC = window.LightweightCharts;
  const ET = window.ET;

  let chart = null;
  let candleSeries = null;
  let volumeSeries = null;
  let container = null;
  let hoverHandler = null;

  const state = {
    symbol: null,
    intraday: true,
    resMin: 5,
    offsetMin: 0, // minute-of-session the source bars are aligned to (0 = 09:30 open)
    lastBar: null,
    hasData: false
  };

  const pad = (n) => String(n).padStart(2, '0');

  function axisTick(time, tickType) {
    const T = LC.TickMarkType;
    if (typeof time === 'string') {
      const [y, m, d] = time.split('-').map(Number);
      if (tickType === T.Year) return String(y);
      if (tickType === T.Month) return ET.MONTHS[m - 1];
      if (tickType === T.DayOfMonth) return String(d);
      return time;
    }
    const p = ET.parts(time * 1000);
    if (tickType === T.Year) return String(p.year);
    if (tickType === T.Month) return ET.MONTHS[p.month - 1];
    if (tickType === T.DayOfMonth) return String(p.day);
    return `${pad(p.hour)}:${pad(p.minute)}`;
  }

  function timeLabel(time) {
    if (typeof time === 'string') {
      const [y, m, d] = time.split('-').map(Number);
      return `${ET.MONTHS[m - 1]} ${d}, ${y}`;
    }
    const p = ET.parts(time * 1000);
    return `${ET.MONTHS[p.month - 1]} ${p.day}, ${p.year}  ${pad(p.hour % 12 === 0 ? 12 : p.hour % 12)}:${pad(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'} ET`;
  }

  function toVolumeBar(bar) {
    const up = bar.close >= bar.open;
    return {
      time: bar.time,
      value: bar.volume || 0,
      color: up ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)'
    };
  }

  function notifyHover(bar) {
    if (hoverHandler) hoverHandler(bar);
  }

  function onCrosshairMove(param) {
    if (!param || !param.time || !param.seriesData) {
      notifyHover(state.lastBar);
      return;
    }
    const bar = param.seriesData.get(candleSeries);
    notifyHover(bar || state.lastBar);
  }

  function create(el) {
    container = el;
    if (!LC) {
      el.innerHTML = '<div class="empty">Chart library failed to load.</div>';
      return api;
    }

    chart = LC.createChart(el, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: 'rgba(0, 0, 0, 0)' }, // glass shows through
        textColor: '#a8b2c7',
        fontSize: 11,
        fontFamily: '"Segoe UI", Roboto, Helvetica, Arial, sans-serif'
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.055)' },
        horzLines: { color: 'rgba(255,255,255,0.055)' }
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.10)',
        scaleMargins: { top: 0.08, bottom: 0.24 }
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.10)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: axisTick
      },
      crosshair: {
        mode: LC.CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(160,172,200,0.5)',
          width: 1,
          style: LC.LineStyle.Dashed,
          labelBackgroundColor: 'rgba(28,35,51,0.9)'
        },
        horzLine: {
          color: 'rgba(160,172,200,0.5)',
          width: 1,
          style: LC.LineStyle.Dashed,
          labelBackgroundColor: 'rgba(28,35,51,0.9)'
        }
      },
      localization: {
        locale: navigator.language || 'en-US',
        timeFormatter: timeLabel
      },
      handleScale: { axisPressedMouseMove: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false }
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: 'rgba(38,166,154,0.85)',
      wickDownColor: 'rgba(239,83,80,0.85)',
      priceLineColor: 'rgba(41,98,255,0.75)',
      priceLineStyle: LC.LineStyle.Dotted,
      priceLineWidth: 1,
      lastValueVisible: true,
      priceLineVisible: true
    });

    volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: ''
    });
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    chart.subscribeCrosshairMove(onCrosshairMove);
    return api;
  }

  function reset() {
    state.hasData = false;
    state.lastBar = null;
    if (candleSeries) {
      candleSeries.setData([]);
      volumeSeries.setData([]);
    }
    notifyHover(null);
  }

  function setSymbol(symbol) {
    state.symbol = symbol;
    reset();
  }

  function setBars(bars, meta) {
    if (!candleSeries) return;
    const list = Array.isArray(bars) ? bars : [];
    state.intraday = meta?.kind !== 'daily';
    state.resMin = meta?.resMin || 5;
    state.hasData = list.length > 0;
    state.lastBar = list.length ? list[list.length - 1] : null;
    state.offsetMin = 0;
    if (state.intraday && state.lastBar && typeof state.lastBar.time === 'number') {
      // Learn where this provider's bars sit inside the session (0 = 09:30-aligned,
      // 30 = hourly bars stamped on the hour) so live ticks fold into the right candle.
      const p = ET.parts(state.lastBar.time * 1000);
      state.offsetMin = (((p.hour * 60 + p.minute - 570) % state.resMin) + state.resMin) % state.resMin;
    }

    chart.applyOptions({ timeScale: { timeVisible: state.intraday, secondsVisible: false } });

    candleSeries.setData(list);
    volumeSeries.setData(list.map(toVolumeBar));

    if (list.length) {
      chart.timeScale().fitContent();
      if (state.intraday) chart.timeScale().scrollToRealTime();
    }
    notifyHover(state.lastBar);
  }

  // Fold a live quote into the currently displayed candle series.
  function applyQuote(quote) {
    if (!candleSeries || !state.hasData || !state.lastBar) return false;
    if (state.symbol && quote.symbol !== state.symbol) return false;

    const price = quote.price;
    if (!Number.isFinite(price)) return false;
    const when = quote.time || Date.now();
    let time;

    if (state.intraday) {
      const p = ET.parts(when);
      const minsFromOpen = p.hour * 60 + p.minute - 570; // 09:30 ET
      if (minsFromOpen < 0 || minsFromOpen > 390) return false; // outside RTH — quote only
      const off = state.offsetMin || 0;
      const bucketMin = Math.floor((minsFromOpen - off) / state.resMin) * state.resMin + off;
      time = Math.floor(when / 1000) - ((minsFromOpen - bucketMin) * 60 + p.second);
    } else {
      time = ET.dateStr(when);
      if (time < state.lastBar.time) return false; // chart is showing an older day
    }

    const last = state.lastBar;
    let bar;
    if (time === last.time) {
      bar = {
        ...last,
        close: price,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        volume: (last.volume || 0) + Math.max(0, quote.volume || 0)
      };
    } else if (time > last.time) {
      bar = {
        time,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: quote.volume || Math.round(15000 + Math.random() * 120000)
      };
    } else {
      return false;
    }

    state.lastBar = bar;
    candleSeries.update(bar);
    volumeSeries.update(toVolumeBar(bar));
    return true;
  }

  function onHover(fn) {
    hoverHandler = fn;
  }

  const api = { create, setSymbol, setBars, applyQuote, reset, onHover };
  return api;
})();
