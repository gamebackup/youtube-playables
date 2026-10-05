/* ---------------------------------------------------------------------------
 * Outlaws Cheat Shop — overlay UI + engine for the Texas Hold'em playable.
 *
 * Depends on two hooks installed by `node cheats/patch-main.js`:
 *     window.__poker  -> the GameplayModel
 *     window.__CC     -> module namespace exposing CardCalculator
 * If either is missing the shop still loads; it just waits for the table.
 *
 * Card encoding (confirmed against GameCardFaceView + CardCalculator):
 *     suit = floor(cardIndex / 13)   0 clubs  1 diamonds  2 hearts  3 spades
 *     rank = (cardIndex % 13) + 1    1 ace .. 13 king
 *
 * Action ids returned by a logicController.handleTurn() (see the local
 * player's controller, which speaks the same protocol as the AI):
 *     0 CHECK   1 CALL   2 FOLD   3 RAISE   4 ALL_IN   5 SIT_OUT   6 SIT_IN
 *
 * AvatarAvalibilityIDs: 0 HIDDEN  1 INACTIVE  2 ACTIVE  3 FOLDED  4 ALL_IN_ACTIVE
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  // This file lives in cheats/, and the pages that load it are not all at the
  // site root (cheats/mockup.html is one level down). Resolving the icon folder
  // against the document would therefore double the path on the mockup, so it is
  // resolved against this script's own URL instead.
  var BASE = (function () {
    var s = document.currentScript;
    if (!s) {
      // Fallback for the odd case where currentScript is gone (older engines,
      // or a re-injected script): find the tag this file came from.
      var tags = document.getElementsByTagName('script');
      for (var i = 0; i < tags.length; i++) {
        if (/shop\.js(\?|#|$)/.test(tags[i].src || '')) { s = tags[i]; break; }
      }
    }
    var url = (s && s.src) || '';
    var i = url.lastIndexOf('/');
    return i < 0 ? 'cheats/' : url.slice(0, i + 1);
  })();

  // ============================================================== constants ==

  var SAVE_KEY = 'outlaws-cheats-v1';
  var START_CREDITS = 150;
  var HAND_PAY = 20; // credits for surviving a hand
  var WIN_BONUS_PER_100 = 1; // extra credits per 100 chips won

  var SUIT_GLYPH = ['♣', '♦', '♥', '♠'];
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  // RANK_VALUE[p] is the poker rank for cardIndex % 13 === p (ace high).
  var RANK_VALUE = [14, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

  var HAND_NAMES = [
    'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush',
    'Full House', 'Four of a Kind', 'Straight Flush', 'Royal Flush',
  ];
  var ACTION_CLASS = { 0: 'check', 1: 'call', 2: 'fold', 3: 'raise', 4: 'raise' };
  // currentRound is the betting round: 1 while hole cards deal, then 2 pre-flop,
  // 3 flop, 4 turn, 5 river (matches AiPokerPlayer_Casual.handleTurn's switch).
  var ROUND_NAME = { 1: 'Dealing', 2: 'Pre-flop', 3: 'Flop', 4: 'Turn', 5: 'River', 6: 'Showdown' };
  var PREFLOP = 2;

  var AVAIL = { HIDDEN: 0, INACTIVE: 1, ACTIVE: 2, FOLDED: 3, ALL_IN_ACTIVE: 4 };
  var BOARD_KEYS = ['tableCard_Flop1', 'tableCard_Flop2', 'tableCard_Flop3', 'tableCard_Turn', 'tableCard_River'];

  // ============================================================ card helpers ==

  function rankPos(cardIndex) { return ((cardIndex % 13) + 13) % 13; }
  function suitPos(cardIndex) { return Math.floor(cardIndex / 13); }
  function rankValue(cardIndex) { return RANK_VALUE[rankPos(cardIndex)]; }
  function isRed(cardIndex) { return suitPos(cardIndex) === 1 || suitPos(cardIndex) === 2; }
  function cardLabel(cardIndex) {
    if (!isCard(cardIndex)) return '--';
    return RANKS[rankPos(cardIndex)] + SUIT_GLYPH[suitPos(cardIndex)];
  }
  function isCard(i) { return typeof i === 'number' && i >= 0 && i < 52 && i % 1 === 0; }

  /** Exchange two deck positions. j === -1 is a no-op. */
  function swapCards(cards, i, j) {
    if (j < 0 || j === i || j >= cards.length) return;
    var t = cards[i]; cards[i] = cards[j]; cards[j] = t;
  }

  /**
   * Identity of a shuffled shoe. The engine shuffles by permuting `_cards` in
   * place, so hashing the whole array detects a reshuffle; merely dealing a
   * card only advances `_currentIndex` and leaves this hash untouched.
   *
   * Store the stamp *after* mutating the deck, otherwise a cheat sees its own
   * write as a fresh shuffle and re-fires forever. `state.deckStamp` is shared
   * by every cheat that reorders the deck so they do not fight each other.
   */
  function deckFingerprint(cards) {
    var h = 2166136261;
    for (var i = 0; i < cards.length; i++) {
      h ^= cards[i];
      h = (h * 16777619) % 4294967296;
    }
    return h + ':' + cards.length;
  }

  // =============================================================== evaluator ==
  //
  // The engine's own CardCalculator is authoritative for the hand *category*,
  // but it is far too slow for Monte Carlo, so equity uses this 7-card
  // evaluator. Scores are plain arrays compared lexicographically.

  function evaluate(cards) {
    var rc = new Int32Array(15), sr = new Int32Array(15), sc = [0, 0, 0, 0], flushSuit = -1;
    var n = 0;
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!isCard(c)) continue;
      var r = rankValue(c), s = suitPos(c);
      rc[r]++; sr[r] |= 1 << s; sc[s]++; n++;
    }
    if (n < 2) return [-1, 0, 0, 0, 0, 0];
    // Fewer than five cards is fine: a straight needs 5 distinct ranks and a
    // flush 5 of a suit, so both simply can't fire on a short hand. Pre-flop
    // therefore still reports pair / high card.

    // flush?
    for (var f = 0; f < 4; f++) if (sc[f] >= 5) flushSuit = f;

    function straightHigh(mask) {
      var best = 0;
      for (var hi = 14; hi >= 5; hi--) {
        var ok = true;
        for (var k = 0; k < 5; k++) if (!(mask & (1 << (hi - k)))) { ok = false; break; }
        if (ok) { best = hi; break; }
      }
      if (best) return best;
      // wheel: A-5
      if ((mask & (1 << 14)) && (mask & (1 << 5)) && (mask & (1 << 4)) &&
          (mask & (1 << 3)) && (mask & (1 << 2))) return 5;
      return 0;
    }

    // straight flush
    if (flushSuit >= 0) {
      var fmask = 0;
      for (var r2 = 2; r2 <= 14; r2++) if (sr[r2] & (1 << flushSuit)) fmask |= 1 << r2;
      var sf = straightHigh(fmask);
      if (sf) return sf === 14 ? [9, 14] : [8, sf];
    }

    // four of a kind / full house / trips
    var quad = 0, trips = [], pairs = [];
    for (var r3 = 14; r3 >= 2; r3--) {
      if (rc[r3] === 4) quad = r3;
      else if (rc[r3] === 3) trips.push(r3);
      else if (rc[r3] === 2) pairs.push(r3);
    }
    if (quad) {
      var kick = 0;
      for (var r4 = 14; r4 >= 2; r4--) if (r4 !== quad && rc[r4]) { kick = r4; break; }
      return [7, quad, kick, 0, 0, 0];
    }
    if (trips.length && (pairs.length || trips.length > 1)) {
      var t = trips[0], p = pairs[0] || trips[1];
      return [6, t, p, 0, 0, 0];
    }

    // flush
    if (flushSuit >= 0) {
      var fr = [];
      for (var r5 = 14; r5 >= 2 && fr.length < 5; r5--) if (sr[r5] & (1 << flushSuit)) fr.push(r5);
      return [5].concat(fr);
    }

    // straight
    var mask = 0;
    for (var r6 = 2; r6 <= 14; r6++) if (rc[r6]) mask |= 1 << r6;
    var sh = straightHigh(mask);
    if (sh) return [4, sh, 0, 0, 0, 0];

    if (trips.length) {
      var k1 = 0, k2 = 0;
      for (var r7 = 14; r7 >= 2; r7--) if (r7 !== trips[0] && rc[r7] && !k1) k1 = r7; else if (r7 !== trips[0] && rc[r7] && k1 && !k2) k2 = r7;
      return [3, trips[0], k1, k2, 0, 0];
    }
    if (pairs.length > 1) {
      var hi2 = pairs[0], lo2 = pairs[1], kick2 = 0;
      for (var r8 = 14; r8 >= 2; r8--) if (r8 !== hi2 && r8 !== lo2 && rc[r8]) { kick2 = r8; break; }
      return [2, hi2, lo2, kick2, 0, 0];
    }
    if (pairs.length === 1) {
      var hp = pairs[0], ks = [];
      for (var r9 = 14; r9 >= 2; r9--) if (r9 !== hp && rc[r9]) { ks.push(r9); if (ks.length === 3) break; }
      return [1, hp].concat(ks, [0, 0]);
    }
    var hiCard = [];
    for (var r10 = 14; r10 >= 2 && hiCard.length < 5; r10--) if (rc[r10]) hiCard.push(r10);
    return [0].concat(hiCard, [0, 0]);
  }

  function compareScore(a, b) {
    for (var i = 0; i < 6; i++) {
      if (a[i] > b[i]) return 1;
      if (a[i] < b[i]) return -1;
    }
    return 0;
  }

  // deterministic PRNG so equity/predictions don't jitter between frames
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  /** Monte Carlo equity of `hole` (and any extra `holes`) against `hole` heads-up. */
  function equity(hole, board, oppHoles, iters, seed) {
    var used = {}, i;
    var mark = function (c) { if (isCard(c)) used[c] = 1; };
    mark(hole[0]); mark(hole[1]);
    for (i = 0; i < board.length; i++) mark(board[i]);
    for (i = 0; i < oppHoles.length; i++) { mark(oppHoles[i][0]); mark(oppHoles[i][1]); }

    var rest = [];
    for (i = 0; i < 52; i++) if (!used[i]) rest.push(i);

    var need = 5 - board.length;
    if (need < 0) need = 0;
    if (need === 0) {
      var mine0 = evaluate(hole.concat(board));
      var oppScores = oppHoles.map(function (h) { return evaluate(h.concat(board)); });
      var wins0 = 0, ties0 = 0;
      oppScores.forEach(function (sc) {
        var c = compareScore(sc, mine0);
        if (c < 0) wins0++;
        else if (c === 0) ties0++;
      });
      return (wins0 + ties0 / (ties0 + 1 || 1)) / (oppScores.length || 1);
    }

    var rand = rng(seed || 0x5eed);
    var pool = rest.slice();
    var wins = 0, ties = 0;
    for (var n = 0; n < iters; n++) {
      // partial Fisher-Yates draw of `need` cards
      var drawn = [];
      for (var d = 0; d < need; d++) {
        var j = d + Math.floor(rand() * (pool.length - d));
        var tmp = pool[d]; pool[d] = pool[j]; pool[j] = tmp;
        drawn.push(pool[d]);
      }
      var full = board.concat(drawn);
      var mine = evaluate(hole.concat(full));
      var beat = false, tied = 0;
      for (var o = 0; o < oppHoles.length; o++) {
        var c2 = compareScore(evaluate(oppHoles[o].concat(full)), mine);
        if (c2 > 0) { beat = true; break; }
        if (c2 === 0) tied++;
      }
      if (beat) continue;
      if (tied === 0) wins++; else ties += 1 / (tied + 1);
    }
    return (wins + ties) / iters;
  }

  // ============================================================ model adapter ==

  function game() { return window.__poker || null; }
  function table() {
    var g = game();
    return g && g.CurrentTable ? g.CurrentTable : null;
  }
  function calculator() {
    var cc = window.__CC;
    return cc && cc.CardCalculator ? cc.CardCalculator : null;
  }

  /** Authoritative hand category from the game's own evaluator. */
  function engineCategory(hole, board) {
    var cc = calculator();
    if (!cc) return null;
    var a = [-1, -1, -1, -1, -1];
    for (var i = 0; i < 5; i++) a[i] = board[i] != null ? board[i] : -1;
    var res;
    try {
      res = cc.getCardCombination(hole[0], hole[1], a[0], a[1], a[2], a[3], a[4]);
    } catch (e) { return null; }
    return Array.isArray(res) ? res[0] : null;
  }

  function handOf(p) {
    var h = p && p.currentHand;
    if (!h) return null;
    return [h.Card1 ? h.Card1.cardIndex : -1, h.Card2 ? h.Card2.cardIndex : -1];
  }

  function boardOf(t) {
    var out = [];
    for (var i = 0; i < BOARD_KEYS.length; i++) {
      var slot = t[BOARD_KEYS[i]];
      out.push(slot && isCard(slot.cardIndex) && slot.visible ? slot.cardIndex : -1);
    }
    // collapse to a contiguous prefix so partial boards evaluate correctly
    var n = 0;
    while (n < out.length && out[n] >= 0) n++;
    return out.slice(0, n);
  }

  function deckOf(t) {
    var d = t.houseCardDealer;
    return d && d.currentDeck ? d.currentDeck : null;
  }

  /** Deck cards already committed to hands or the board — used to grey the picker. */
  function usedCards(t) {
    var used = {}, i;
    var all = [t.playerObj].concat(t.opponentList || []);
    for (i = 0; i < all.length; i++) {
      var h = handOf(all[i]);
      if (h) { used[h[0]] = 1; used[h[1]] = 1; }
    }
    var b = boardOf(t);
    for (i = 0; i < b.length; i++) used[b[i]] = 1;
    return used;
  }

  function botsInHand(t) {
    return (t.opponentList || []).filter(function (b) {
      var h = handOf(b);
      return h && isCard(h[0]) && isCard(h[1]) && b.availability !== AVAIL.HIDDEN;
    });
  }

  function potOf(t) {
    var d = t.houseCardDealer;
    if (!d) return 0;
    var p = d.displayPot || d.currentPot || d.potValue;
    return (p && typeof p.value === 'number') ? p.value : (typeof p === 'number' ? p : 0);
  }

  function moneyOf(p) { return p && p.moneyPool ? p.moneyPool.value : 0; }
  function betOf(p) { return p && p.currentBet ? p.currentBet.value : 0; }
  function nameOf(p) {
    if (!p) return '???';
    var n = p.name;
    if (!n) return '???';
    return n.value || n.text || n.textValue || 'Player';
  }

  // ================================================================== state ===

  var state = {
    credits: START_CREDITS,
    owned: {},
    active: {},
    opts: { mind: 'passive', tax: 25, slot: 0, sleeveCard: -1, bottomCard: -1 },
    seenHand: -1,
    handStartMoney: 0,
    lastBet: {},
    lastAction: {},
    diceUsed: false,
    deckStamp: '',
    shreddedLen: 0,
    // Which cheats have actually been applied to the live table, so engineTick
    // knows which ones still need unwinding. Runtime only, never persisted.
    installed: {},
    tell: null,
    predict: null,
  };

  function load() {
    try {
      var raw = window.localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (typeof d.credits === 'number') state.credits = d.credits;
      if (d.owned) state.owned = d.owned;
      if (d.active) state.active = d.active;
      if (d.opts) state.opts = Object.assign(state.opts, d.opts);
    } catch (e) { /* corrupt save: start fresh */ }
  }

  function save() {
    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify({
        credits: state.credits, owned: state.owned, active: state.active, opts: state.opts,
      }));
    } catch (e) { /* private mode: run without persistence */ }
  }

  // ================================================================== items ===

  //
  // Each item owns its engine logic. `tick(ctx)` runs ~12x/second while the
  // item is owned and active and returns a short status line for the shop card.
  //
  var ITEMS = [

    { // -------------------------------------------------------------------
      id: 'xray', icon: 'xray', name: 'X-Ray Vision', price: 120, mode: 'toggle',
      blurb: 'Turns every opponent’s hole cards face up for the rest of the hand.',
      tick: function (ctx) {
        var n = 0;
        for (var i = 0; i < ctx.bots.length; i++) {
          var h = ctx.bots[i].currentHand;
          if (h.Card1) h.Card1.cardFaceUp = true;
          if (h.Card2) h.Card2.cardFaceUp = true;
          n++;
        }
        return n ? 'revealing ' + n + ' opponent' + (n > 1 ? 's' : '') : 'no opponents in hand';
      },
      off: function (t) {
        var all = (t.opponentList || []).concat([t.playerObj]);
        for (var i = 0; i < all.length; i++) {
          var h = all[i].currentHand;
          if (!h) continue;
          if (h.Card1) h.Card1.cardFaceUp = false;
          if (h.Card2) h.Card2.cardFaceUp = false;
        }
      },
    },

    { // -------------------------------------------------------------------
      id: 'tell', icon: 'tell', name: 'Tell Detector', price: 200, mode: 'toggle',
      blurb: 'Reads the table and shows your equity against every live opponent.',
      tick: function (ctx) {
        state.tell = readTell(ctx);
        var t = state.tell;
        return t.rows.length
          ? t.rows.length + ' opponent' + (t.rows.length > 1 ? 's' : '') + ' · avg ' + Math.round(t.avg) + '%'
          : 'waiting for a hand';
      },
      off: function () { state.tell = null; },
    },

    { // -------------------------------------------------------------------
      id: 'predictor', icon: 'predictor', name: 'Fold Predictor', price: 180, mode: 'toggle',
      blurb: 'Runs the bot’s own decision code against a fixed dice roll so you can see what it will do.',
      tick: function (ctx) {
        state.predict = readPredict(ctx);
        var p = state.predict;
        if (!p) return 'waiting for an opponent turn';
        return p.action + ' · ' + p.call + ' to call';
      },
      off: function () { state.predict = null; },
    },

    { // -------------------------------------------------------------------
      id: 'sleeve', icon: 'sleeves', name: 'Sleeve Swap', price: 150, mode: 'armed',
      blurb: 'Slip a new card into either of your hole cards mid-hand.',
      tick: function (ctx) {
        if (state.opts.sleeveCard < 0) return 'choose a card to palm';
        var slot = state.opts.slot === 0 ? 'Card1' : 'Card2';
        var hand = ctx.me.currentHand;
        if (!hand || !hand[slot]) return 'no hole cards this hand';
        hand[slot].cardIndex = state.opts.sleeveCard;
        var label = cardLabel(state.opts.sleeveCard);
        state.opts.sleeveCard = -1;
        save();
        return 'swapped in ' + label;
      },
    },

    { // -------------------------------------------------------------------
      id: 'insidejob', icon: 'insidejob', name: 'Inside Job', price: 250, mode: 'toggle',
      blurb: 'Skims 25% off every chip an opponent puts in and slides it into your stack.',
      tick: function (ctx) {
        var skim = 0;
        for (var i = 0; i < ctx.bots.length; i++) {
          var b = ctx.bots[i], key = nameOf(b);
          var bet = betOf(b);
          var prev = state.lastBet[key];
          state.lastBet[key] = bet;
          if (prev != null && bet > prev && ctx.me) {
            var cut = Math.floor((bet - prev) * 0.25);
            if (cut > 0) {
              ctx.me.moneyPool.value += cut;
              skim += cut;
            }
          }
        }
        return skim ? 'skimmed ' + skim + ' this tick' : 'siphoning 25% of their bets';
      },
      off: function () { state.lastBet = {}; },
    },

    { // -------------------------------------------------------------------
      id: 'taxman', icon: 'taxman', name: 'The Taxman', price: 300, mode: 'toggle',
      opts: [{ id: 'tax', values: [10, 25, 50, 100], label: function (v) { return v + ' chips'; } }],
      blurb: 'Every time a bot checks instead of betting, you take a slice of their stack.',
      tick: function (ctx) {
        var fee = state.opts.tax, taken = 0;
        for (var i = 0; i < ctx.bots.length; i++) {
          var b = ctx.bots[i], key = nameOf(b);
          var act = b.actionId;
          var prev = state.lastAction[key];
          state.lastAction[key] = act;
          if (act === 0 && prev !== 0 && ctx.me) {
            var amount = Math.min(fee, moneyOf(b));
            if (amount > 0) {
              b.moneyPool.value -= amount;
              ctx.me.moneyPool.value += amount;
              taken += amount;
            }
          }
        }
        return taken ? 'collected ' + taken + ' from ' + ctx.bots.length + ' checkers'
          : 'collecting ' + fee + ' per bot check';
      },
      off: function () { state.lastAction = {}; },
    },

    { // -------------------------------------------------------------------
      id: 'dice', icon: 'dice', name: 'Loaded Dice', price: 150, mode: 'toggle',
      blurb: 'Bumps you back your ante whenever you fold before the flop.',
      tick: function (ctx) {
        var t = ctx.t, me = ctx.me;
        var ante = (t.houseCardDealer && t.houseCardDealer.baseBetAmount) || 0;
        if (!state.diceUsed && me && ante > 0 && ctx.foldedPreFlop) {
          me.moneyPool.value += ante;
          state.diceUsed = true;
          save();
          return 'ante refunded: +' + ante;
        }
        return state.diceUsed ? 'used this hand' : 'ante refund armed (' + ante + ')';
      },
      off: function () { state.diceUsed = false; },
    },

    { // -------------------------------------------------------------------
      id: 'stack', icon: 'stack', name: 'Stacked Deck', price: 350, mode: 'toggle',
      blurb: 'Reorders the deck once per hand so the best cards left come off the top.',
      tick: function (ctx) {
        var deck = ctx.deck;
        if (!deck || !Array.isArray(deck._cards)) return 'no deck';
        var cards = deck._cards, top = deck._currentIndex || 0;
        if (cards.length - top < 2) return 'deck is empty';
        // Stack once per shuffle, judged by the shoe's contents.
        if (state.deckStamp === deckFingerprint(cards)) return 'deck is stacked';
        var best = -1, bestPos = -1, secondPos = -1, secondVal = -1;
        for (var i = top; i < cards.length; i++) {
          var v = rankValue(cards[i]) * 4 + suitPos(cards[i]);
          if (v > best) { secondPos = bestPos; secondVal = best; best = v; bestPos = i; }
          else if (v > secondVal) { secondVal = v; secondPos = i; }
        }
        if (bestPos === top && secondPos === top + 1) {
          state.deckStamp = deckFingerprint(cards);
          return 'deck is stacked';
        }
        // Swap (never overwrite) so no card can ever be duplicated, and search
        // for the runner-up by value because the first swap may have moved it.
        var secondCard = cards[secondPos];
        swapCards(cards, top, bestPos);
        swapCards(cards, top + 1, cards.indexOf(secondCard, top + 1));
        state.deckStamp = deckFingerprint(cards); // after the write, not before
        return 'stacked ' + cardLabel(cards[top]) + ' ' + cardLabel(cards[top + 1]);
      },
      off: function () { state.deckStamp = ''; },
    },

    { // -------------------------------------------------------------------
      id: 'bottom', icon: 'bottom', name: 'Bottom Deal', price: 300, mode: 'armed',
      blurb: 'Pick a card and it becomes the next one dealt off the deck.',
      tick: function (ctx) {
        var want = state.opts.bottomCard;
        if (want < 0) return 'choose a card to force';
        var deck = ctx.deck;
        if (!deck || !Array.isArray(deck._cards)) return 'no deck';
        var cards = deck._cards, top = deck._currentIndex || 0;
        if (top >= cards.length) return 'deck is empty';
        var pos = cards.indexOf(want, top);
        if (pos < 0) return cardLabel(want) + ' is not in the deck';
        if (pos === top) return cardLabel(want) + ' is already on top';
        swapCards(cards, top, pos);
        state.deckStamp = deckFingerprint(cards); // claim this shuffle
        state.opts.bottomCard = -1;
        save();
        return 'next deal is ' + cardLabel(want);
      },
    },

    { // -------------------------------------------------------------------
      id: 'shredder', icon: 'shredder', name: 'Card Shredder', price: 275, mode: 'toggle',
      blurb: 'Burns every 2, 3 and 4 in the shoe each hand. Boring hands become good ones.',
      tick: function (ctx) {
        var deck = ctx.deck;
        if (!deck || !Array.isArray(deck._cards)) return 'no deck';
        var cards = deck._cards;
        var top = deck._currentIndex || 0;
        // Wait for a freshly shuffled 52-card shoe, then strip the 2s/3s/4s.
        // Already shredded shoes are left alone until the engine refills.
        if (cards.length === 52 && top === 0) {
          deck._cards = cards.filter(function (c) {
            var p = rankPos(c);
            return p !== 1 && p !== 2 && p !== 3; // 2, 3, 4
          });
          state.shreddedLen = deck._cards.length;
          state.deckStamp = deckFingerprint(deck._cards);
          return 'shredded 12 cards';
        }
        return state.shreddedLen
          ? 'shoe is down to ' + cards.length + ' cards'
          : 'waiting for a fresh shoe';
      },
      off: function () { state.shreddedLen = 0; },
    },

    { // -------------------------------------------------------------------
      id: 'mind', icon: 'mindcontrol', name: 'Mind Control', price: 400, mode: 'armed',
      opts: [
        { id: 'mind', values: ['fold', 'check', 'passive'], label: function (v) {
          return { fold: 'All fold', check: 'All check', passive: 'Never raise' }[v];
        } },
      ],
      blurb: 'Overwrites the opponents’ decision function. Their eyes go blank.',
      tick: function (ctx) {
        var mode = state.opts.mind;
        for (var i = 0; i < ctx.bots.length; i++) {
          var c = ctx.bots[i].logicController;
          if (!c) continue;
          if (mode === 'off') { delete c.handleTurn; continue; }
          if (c.__cheatMode === mode) continue;
          if (c.__cheatOriginal) delete c.handleTurn;
          c.__cheatMode = mode;
          c.handleTurn = mode === 'fold'
            ? function () { return 2; }                       // FOLD
            : mode === 'check'
              ? function (t, dt, model, p) {                  // CHECK or CALL
                var d = model.CurrentTable.houseCardDealer;
                return d.currentHighBetValue === p.currentBet.value ? 0 : 1;
              }
              : function () {                                  // never raise
                return this.handQuality && this._canCheck ? 0 : 1;
              };
          c.__cheatOriginal = true;
        }
        var n = ctx.bots.length;
        return n ? { fold: 'every bot will fold', check: 'every bot will check', passive: 'bots will only call' }[mode]
          : 'no opponents in hand';
      },
      off: function (t) {
        var all = (t.opponentList || []);
        for (var i = 0; i < all.length; i++) {
          var c = all[i].logicController;
          if (c && c.__cheatMode) { delete c.handleTurn; delete c.__cheatMode; delete c.__cheatOriginal; }
        }
      },
    },
  ];

  var ITEM_BY_ID = {};
  ITEMS.forEach(function (it) { ITEM_BY_ID[it.id] = it; });

  // ================================================================= readers ==

  function readTell(ctx) {
    var t = ctx.t, rows = [], sum = 0, i;
    var mine = handOf(t.playerObj);
    var board = boardOf(t);
    var bots = botsInHand(t);
    for (i = 0; i < bots.length; i++) {
      var b = bots[i];
      var h = handOf(b);
      var inHand = isCard(h[0]) && isCard(h[1]);
      // A bot with no cards dealt has no hand to categorise. Guarding this
      // matters: otherwise the local evaluator happily reads the *board*
      // alone and reports its category as if it were the bot's.
      var cat = inHand ? engineCategory(h, board) : -1;
      // The engine answers CardCombinationPowersID.INVALID (-1) for a hand it
      // can't read; fall back to the local evaluator so pre-flop still shows
      // a category instead of "Unknown".
      if (cat == null || cat < 0) cat = inHand ? evaluate(h.concat(board))[0] : -1;
      var eq = isCard(mine[0]) && isCard(mine[1]) && isCard(h[0]) && isCard(h[1])
        ? equity(mine, board, [h], 900, 0x9e37 + i) : 0;
      sum += eq;
      rows.push({
        name: nameOf(b),
        cards: [cardLabel(h[0]), cardLabel(h[1])],
        red: [isRed(h[0]), isRed(h[1])],
        hand: HAND_NAMES[cat] || 'Unknown',
        equity: eq,
        folded: b.availability === AVAIL.FOLDED,
        allIn: b.availability === AVAIL.ALL_IN_ACTIVE,
      });
    }
    return { rows: rows, avg: bots.length ? sum / bots.length * 100 : 0 };
  }

  //
  // Calls the bot's own handleTurn with a frozen random source, so the answer is
  // the real decision code's output rather than a re-implementation of it.
  //
  // handleTurn(timeLeft, dt, model, player) is invoked by the engine as
  // (currentTime / MAX_THINK_TIME, dt, ...), i.e. a 0..1 fraction — and the AI
  // gives up and folds once timeLeft >= 0.97. We sample at 0.5 so we always get
  // its considered opinion rather than the timeout.
  //
  function readPredict(ctx) {
    var t = ctx.t;
    var active = null;
    try { active = t.getActivePlayer(); } catch (e) { active = null; }
    if (!active || !active.logicController || active === t.playerObj) return null;

    var ctrl = active.logicController;
    var hadOwnRandom = Object.prototype.hasOwnProperty.call(ctrl, '_random');
    var origRandom = ctrl._random;
    var origAllIns = active.concurrentAllIns;
    var samples = {}, action = null;

    for (var i = 0; i < 5; i++) {
      var roll = (i + 1) / 6; // 0.17 .. 0.83
      ctrl._random = { random: function () { return roll; } };
      var res = null;
      try {
        res = ctrl.handleTurn(0.5, 0.016, game(), active);
      } catch (e) {
        res = null;
      }
      res = typeof res === 'number' ? res : -1;
      if (action === null) action = res;
      samples[res] = (samples[res] || 0) + 1;
    }

    // undo the probe so the bot's real turn is unaffected
    if (hadOwnRandom) ctrl._random = origRandom; else delete ctrl._random;
    active.concurrentAllIns = origAllIns;

    var rank = { 0: 'Check', 1: 'Call', 2: 'Fold', 3: 'Raise', 4: 'All In' };
    var pct = [];
    for (var key in samples) {
      if (!Object.prototype.hasOwnProperty.call(samples, key)) continue;
      var id = Number(key);
      pct.push({ id: id, action: rank[id] || 'Timeout', n: samples[id] * 20 });
    }
    pct.sort(function (a, b) { return b.n - a.n; });

    var dealer = t.houseCardDealer || {};
    var toCall = Math.max(0, (dealer.currentHighBetValue || 0) - betOf(active));
    return {
      name: nameOf(active),
      actionId: action,
      action: rank[action] || 'Timeout',
      distribution: pct,
      call: ctrl._canCheck ? 'nothing to call'
        : ctrl._canCall ? toCall + ' to call'
          : 'cannot raise',
      bet: ctrl.finalBetAmount || 0,
      pct: pct.length ? pct[0].n : 0,
    };
  }

  // =================================================================== engine ==

  function context() {
    var t = table();
    if (!t) return null;
    var bots = (t.opponentList || []).filter(function (b) {
      return b.availability !== AVAIL.HIDDEN;
    });
    var me = t.playerObj;
    var foldedPreFlop = me && me.availability === AVAIL.FOLDED && (t.currentRound || PREFLOP) <= PREFLOP;
    return {
      t: t,
      me: me,
      bots: bots,
      deck: deckOf(t),
      board: boardOf(t),
      round: t.currentRound || 1,
      pot: potOf(t),
      foldedPreFlop: foldedPreFlop,
    };
  }

  var lastStatus = {};

  function engineTick() {
    var ctx = context();
    if (!ctx) {
      setConnected(false);
      return;
    }
    setConnected(true);

    // new-hand bookkeeping: pay out and reset per-hand cheat state
    var handNo = ctx.t.currentHandNumber || 0;
    if (handNo && handNo !== state.seenHand) {
      var first = state.seenHand === -1;
      state.seenHand = handNo;
      state.diceUsed = false;
      state.deckStamp = ''; // force the deck cheats to re-examine this shuffle
      state.lastBet = {};
      state.lastAction = {};
      if (!first) {
        var won = Math.max(0, moneyOf(ctx.me) - state.handStartMoney);
        var pay = HAND_PAY + Math.floor(won / 100) * WIN_BONUS_PER_100;
        state.credits += pay;
        save();
        toast('+' + pay + ' cred — hand ' + handNo + (won > 0 ? ' · won ' + won : ''), 'good');
      }
      state.handStartMoney = moneyOf(ctx.me);
    }

    for (var i = 0; i < ITEMS.length; i++) {
      var it = ITEMS[i];
      // Cleanup is driven off the flag, not off which button was pressed, so
      // clearing state.active from the console (CheatShop is documented for
      // tinkering) unwinds the cheat just like clicking Disable does. Without
      // this a hand-rolled toggle would leave an override shadowing handleTurn
      // or cards stuck face up.
      if (!state.owned[it.id] || !state.active[it.id]) {
        if (state.installed[it.id] && it.off) {
          try { it.off(ctx.t); } catch (e) { /* table gone */ }
          state.installed[it.id] = false;
        }
        continue;
      }
      try {
        lastStatus[it.id] = it.tick(ctx) || '';
        state.installed[it.id] = true;
      } catch (e) {
        lastStatus[it.id] = 'error: ' + (e && e.message ? e.message : e);
      }
    }
    renderPanelStatus();
    renderHud(ctx);
  }

  // ====================================================================== UI ===

  var root, el = {};
  var ui = { open: false, connected: false, credits: -1, picker: null };

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  //
  // Icons: the placeholder below is rendered inline, so the shop looks right and
  // is never broken by a missing asset, with no network involved.
  //
  // To use your own art, drop a file into cheats/icons/ and point the cheat at
  // it in cheats/icons/icons.json. A manifest is used rather than probing for
  // <id>.png / <id>.svg because a missing-file probe logs a console error per
  // icon per page load, and there are twelve of them until the art arrives.
  //
  var ICON_DIR = BASE + 'icons/';
  var iconManifest = null;   // null until loaded; then { id: filename }

  function loadIconManifest() {
    if (iconManifest || !window.fetch) return;
    iconManifest = {};
    fetch(ICON_DIR + 'icons.json', { cache: 'no-store' }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (d) {
      if (!d) return;
      var any = false;
      Object.keys(d).forEach(function (k) {
        // Leading underscore marks a comment key, not a mapping.
        if (k.charAt(0) === '_') return;
        var v = d[k];
        if (typeof v === 'string' && v) { iconManifest[k] = v; any = true; }
      });
      // The first paint happened before this resolved, so repaint the icons.
      if (any && root) { renderPanel(); buildOpenBtn(); }
    }).catch(function () { /* keep placeholders */ });
  }

  var PLACEHOLDER = {
    badge: { tint: '#f0b429', body: '<path d="M16 24h32l-3 22a4 4 0 0 1-4 3H23a4 4 0 0 1-4-3z"/><path d="M24 24v-6a8 8 0 0 1 16 0v6"/>' },
    xray: { tint: '#5ad1ff', body: '<path d="M6 32s10-16 26-16 26 16 26 16-10 16-26 16S6 32 6 32z"/><circle cx="32" cy="32" r="8"/><circle cx="32" cy="32" r="3"/>' },
    tell: { tint: '#c792ea', body: '<circle cx="27" cy="27" r="14"/><path d="M37 37l12 12"/><path d="M22 27h10M27 22v10"/>' },
    predictor: { tint: '#ffd166', body: '<circle cx="32" cy="32" r="18"/><path d="M26 26a6 6 0 1 1 8 8c-2 1-2 3-2 3"/><circle cx="32" cy="44" r="1.6" fill="currentColor" stroke="none"/>' },
    sleeves: { tint: '#7ee787', body: '<rect x="10" y="20" width="18" height="26" rx="3"/><rect x="36" y="20" width="18" height="26" rx="3"/><path d="M30 30h4M32 28l2 2-2 2"/>' },
    insidejob: { tint: '#ff8c69', body: '<rect x="8" y="18" width="48" height="30" rx="4"/><circle cx="32" cy="33" r="8"/><path d="M12 25h8M44 25h8"/>' },
    taxman: { tint: '#ff6b81', body: '<path d="M18 44V26a14 14 0 0 1 28 0v18"/><path d="M18 44h10V32H18zM36 44h10V32H36z"/>' },
    dice: { tint: '#9ad5ff', body: '<rect x="12" y="12" width="40" height="40" rx="8"/><circle cx="23" cy="23" r="3" fill="currentColor" stroke="none"/><circle cx="41" cy="41" r="3" fill="currentColor" stroke="none"/><circle cx="32" cy="32" r="3" fill="currentColor" stroke="none"/>' },
    stack: { tint: '#b0f2c6', body: '<rect x="12" y="14" width="40" height="14" rx="3"/><rect x="12" y="30" width="40" height="14" rx="3"/><rect x="12" y="46" width="40" height="6" rx="3"/>' },
    bottom: { tint: '#ffd8a8', body: '<rect x="14" y="30" width="36" height="24" rx="4"/><path d="M32 8v16M26 18l6 6 6-6"/>' },
    shredder: { tint: '#ffa8a8', body: '<rect x="14" y="14" width="36" height="20" rx="4"/><path d="M20 40l-2 10M28 40v10M36 40l2 10M44 40l4 10"/>' },
    mindcontrol: { tint: '#d0a2ff', body: '<circle cx="32" cy="26" r="12"/><path d="M20 50c0-7 5-12 12-12s12 5 12 12"/><path d="M24 20a8 8 0 0 1 16 0"/>' },
  };

  function placeholderSVG(id) {
    var def = PLACEHOLDER[id];
    if (!def) return '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
      '<rect x="2" y="2" width="60" height="60" rx="14" fill="#12211b" stroke="' + def.tint + '" stroke-width="2.5"/>' +
      '<g fill="none" stroke="' + def.tint + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
      def.body + '</g></svg>';
  }

  function iconEl(id, cls) {
    var wrap = h('div', cls);
    wrap.innerHTML = placeholderSVG(id); // visible at once, needs no network
    var file = iconManifest && iconManifest[id];
    if (file) {
      var img = new Image();
      img.alt = '';
      img.onload = function () {
        wrap.textContent = '';
        wrap.appendChild(img);
      };
      // A bad path leaves the placeholder in place rather than showing a
      // broken image, so a typo in icons.json is harmless.
      img.src = ICON_DIR + file;
    }
    return wrap;
  }

  function toast(msg, kind) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.className = 'cs-toast show' + (kind ? ' ' + kind : '');
    clearTimeout(ui._toastT);
    ui._toastT = setTimeout(function () { el.toast.className = 'cs-toast'; }, 2600);
  }

  function setConnected(v) {
    if (ui.connected === v) return;
    ui.connected = v;
    if (!el.open) return;
    el.open.querySelector('.cs-open-cred').textContent = v ? state.credits + ' CRED' : 'NO TABLE';
    if (!v) renderHud(null);
  }

  // The open button is rebuilt when the icon manifest resolves, since its icon
  // is the one most likely to be swapped out.
  //
  // The manifest is read with cache: 'no-store' because it is meant to be
  // hand-edited when you drop in art; a cached copy would mean editing the file
  // and reloading still shows the old icons.
  function buildOpenBtn() {
    el.open.textContent = '';
    el.open.appendChild(iconEl('badge', 'cs-open-icon'));
    var lbl = h('span', 'cs-open-label');
    lbl.appendChild(h('span', 'cs-open-title', 'SHOP'));
    el.cred = h('span', 'cs-open-cred', state.credits + ' CRED');
    lbl.appendChild(el.cred);
    el.open.appendChild(lbl);
  }

  function build() {
    root = h('div');
    root.id = 'cheat-root';

    // open button ---------------------------------------------------------
    el.open = h('button', 'cs-btn cs-open');
    el.open.type = 'button';
    el.open.title = 'Cheat shop';
    buildOpenBtn();
    el.open.onclick = function () { ui.open ? closePanel() : openPanel(); };
    root.appendChild(el.open);

    // hud -----------------------------------------------------------------
    el.hud = h('div', 'cs-hud');
    root.appendChild(el.hud);

    // panel ---------------------------------------------------------------
    el.scrim = h('div', 'cs-scrim');
    el.scrim.style.display = 'none';
    el.panel = h('div', 'cs-panel');

    var head = h('div', 'cs-head');
    var titleWrap = h('div');
    titleWrap.appendChild(h('h2', null, 'Cheat Shop'));
    titleWrap.appendChild(h('div', 'cs-sub', 'Nothing is real here. Not your chips, not theirs.'));
    head.appendChild(titleWrap);
    head.appendChild(h('div', 'cs-head-spacer'));
    el.cred2 = h('div', 'cs-cred', state.credits + ' CRED');
    head.appendChild(el.cred2);
    var x = h('button', 'cs-btn cs-x', '\u2715');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close shop');
    x.onclick = closePanel;
    head.appendChild(x);
    el.panel.appendChild(head);

    el.grid = h('div', 'cs-grid');
    el.panel.appendChild(el.grid);

    el.scrim.appendChild(el.panel);
    el.scrim.onclick = function (e) { if (e.target === el.scrim) closePanel(); };
    root.appendChild(el.scrim);

    el.picker = h('div', 'cs-picker');
    el.picker.style.display = 'none';
    root.appendChild(el.picker);

    el.toast = h('div', 'cs-toast');
    root.appendChild(el.toast);

    document.body.appendChild(root);
    loadIconManifest();
    renderPanel();
  }

  function openPanel() {
    ui.open = true;
    el.scrim.style.display = 'flex';
    renderPanel();
    var first = el.grid.querySelector('.cs-btn');
    if (first) first.focus();
  }

  function closePanel() {
    ui.open = false;
    el.scrim.style.display = 'none';
    closePicker();
  }

  // ---------------------------------------------------------------- panel --

  function renderPanel() {
    if (!el.grid) return;
    el.grid.textContent = '';
    el.cred2.textContent = state.credits + ' CRED';
    el.cred.textContent = state.credits + ' CRED';

    for (var i = 0; i < ITEMS.length; i++) {
      el.grid.appendChild(itemCard(ITEMS[i]));
    }
  }

  /**
   * Refresh just the live status lines. Rebuilding the whole panel here would
   * fight the user's focus and any open card picker on every 90ms tick.
   */
  function renderPanelStatus() {
    if (!ui.open || !el.grid) return;
    for (var i = 0; i < el.grid.children.length; i++) {
      var card = el.grid.children[i];
      var node = card.querySelector('.cs-state');
      var it = ITEMS[i];
      if (!node || !it) continue;
      var active = !!state.active[it.id];
      node.className = 'cs-state' + (active ? '' : ' dim');
      var next = active ? (lastStatus[it.id] || 'active') : '';
      if (node.textContent !== next) node.textContent = next;
    }
  }

  function itemCard(it) {
    var owned = !!state.owned[it.id];
    var active = !!state.active[it.id];

    var card = h('div', 'cs-item' + (owned ? ' owned' : '') + (active ? ' active' : ''));
    var top = h('div', 'cs-item-top');
    top.appendChild(iconEl(it.icon, 'cs-item-icon'));
    var titles = h('div');
    titles.appendChild(h('h3', null, it.name));
    titles.appendChild(h('p', null, it.blurb));
    top.appendChild(titles);
    card.appendChild(top);

    if (it.opts && owned) {
      var row = h('div', 'cs-opts');
      for (var o = 0; o < it.opts.length; o++) {
        var spec = it.opts[o];
        for (var v = 0; v < spec.values.length; v++) {
          (function (spec, val) {
            var b = h('button', 'cs-opt', spec.label ? spec.label(val) : String(val));
            b.type = 'button';
            b.setAttribute('aria-pressed', String(state.opts[spec.id] === val));
            b.onclick = function () {
              state.opts[spec.id] = val;
              save();
              if (spec.id === 'mind') forceRetick();
              renderPanel();
            };
            row.appendChild(b);
          })(spec, spec.values[v]);
        }
      }
      card.appendChild(row);
    }

    var status = lastStatus[it.id] || '';
    var st = h('div', 'cs-state' + (active ? '' : ' dim'), active ? (status || 'active') : '');
    card.appendChild(st);

    var foot = h('div', 'cs-item-foot');
    if (!owned) {
      foot.appendChild(h('span', 'cs-price', it.price + ' CRED'));
      var buy = h('button', 'cs-btn', state.credits >= it.price ? 'Buy' : 'Short');
      buy.type = 'button';
      buy.disabled = state.credits < it.price;
      buy.onclick = function () {
        if (state.credits < it.price) return toast('Not enough credit', 'bad');
        state.credits -= it.price;
        state.owned[it.id] = true;
        state.active[it.id] = it.mode !== 'armed' || it.id === 'sleeve' || it.id === 'bottom';
        save();
        toast(it.name + ' acquired', 'good');
        if (it.id === 'sleeve' || it.id === 'bottom') openPicker(it.id);
        renderPanel();
      };
      foot.appendChild(buy);
    } else {
      foot.appendChild(h('span', 'cs-price', 'OWNED'));
      var isToggle = it.mode === 'toggle' || it.mode === 'armed';
      var t = h('button', 'cs-btn' + (active ? ' on' : ''), active ? 'Disable' : 'Enable');
      t.type = 'button';
      if (isToggle) {
        // Just flip the flag; engineTick() notices and runs it.off() so there
        // is a single cleanup path shared with the console API.
        t.onclick = function () {
          state.active[it.id] = !state.active[it.id];
          save();
          renderPanel();
        };
      } else {
        t.textContent = 'Select';
        t.onclick = function () { openPicker(it.id); };
      }
      foot.appendChild(t);
    }
    card.appendChild(foot);
    return card;
  }

  // --------------------------------------------------------------- picker --

  function openPicker(id) {
    var t = table();
    if (!t) return toast('No table yet', 'bad');
    var used = usedCards(t);
    ui.picker = id;
    el.picker.textContent = '';

    var head = h('div', 'cs-hud-title');
    head.appendChild(h('span', null, id === 'sleeve' ? 'Palmed card' : 'Force next deal'));
    head.appendChild(h('small', null, 'greyed = in use'));
    el.picker.appendChild(head);

    var grid = h('div', 'cs-picker-grid');
    for (var i = 0; i < 52; i++) {
      (function (idx) {
        var b = h('button', 'cs-pick' + (isRed(idx) ? ' red' : '') + (used[idx] ? ' used' : ''), RANKS[rankPos(idx)] + SUIT_GLYPH[suitPos(idx)]);
        b.type = 'button';
        b.disabled = !!used[idx];
        if (id === 'sleeve') {
          b.title = 'Swap into hole card ' + (state.opts.slot + 1);
          if (state.opts.sleeveCard === idx) b.style.outline = '2px solid #f0b429';
          b.onclick = function () {
            state.opts.sleeveCard = idx;
            save();
            closePicker();
            renderPanel();
          };
        } else {
          b.title = 'Force ' + cardLabel(idx);
          if (state.opts.bottomCard === idx) b.style.outline = '2px solid #f0b429';
          b.onclick = function () {
            state.opts.bottomCard = idx;
            save();
            closePicker();
            renderPanel();
          };
        }
        grid.appendChild(b);
      })(i);
    }
    el.picker.appendChild(grid);

    var foot = h('div', 'cs-picker-foot');
    if (id === 'sleeve') {
      for (var s = 0; s < 2; s++) {
        (function (slot) {
          var b = h('button', 'cs-opt', 'Hole card ' + (slot + 1));
          b.type = 'button';
          b.setAttribute('aria-pressed', String(state.opts.slot === slot));
          b.onclick = function () {
            state.opts.slot = slot;
            save();
            openPicker('sleeve');
          };
          foot.appendChild(b);
        })(s);
      }
    }
    var cancel = h('button', 'cs-btn', 'Close');
    cancel.type = 'button';
    cancel.onclick = closePicker;
    foot.appendChild(cancel);
    el.picker.appendChild(foot);

    // keep it inside the viewport
    el.picker.style.display = 'block';
    var r = el.picker.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    el.picker.style.left = Math.max(8, Math.min(vw - r.width - 8, (vw - r.width) / 2)) + 'px';
    el.picker.style.top = Math.max(8, Math.min(vh - r.height - 8, vh * 0.28)) + 'px';
  }

  function closePicker() {
    ui.picker = null;
    if (el.picker) el.picker.style.display = 'none';
  }

  // ------------------------------------------------------------------ hud --

  function renderHud(ctx) {
    if (!el.hud) return;
    el.hud.textContent = '';
    if (!ctx) return;

    var reveal = !!state.active.xray;
    var tell = state.active.tell ? state.tell : null;
    var predict = state.active.predictor ? state.predict : null;
    if (!reveal && !tell && !predict) return;

    var card = h('div', 'cs-card');
    var head = h('div', 'cs-hud-title');
    head.appendChild(h('span', null, tell ? 'Tell detector' : 'Table read'));
    head.appendChild(h('small', null, ROUND_NAME[ctx.round] || ''));
    card.appendChild(head);

    var rows = tell ? tell.rows : null;
    if (rows) {
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var row = h('div', 'cs-row');

        var nm = h('div', 'cs-row-name');
        nm.appendChild(document.createTextNode(r.name));
        nm.appendChild(h('em', null, ' ' + r.hand));
        row.appendChild(nm);

        var cards = h('div', 'cs-cards');
        for (var c = 0; c < 2; c++) {
          if (r.folded && !reveal) {
            cards.appendChild(h('div', 'cs-card-chip back', '\u2016'));
          } else {
            var chip = h('div', 'cs-card-chip' + (r.red[c] ? ' red' : ''), r.cards[c]);
            chip.title = r.cards[c];
            cards.appendChild(chip);
          }
        }
        row.appendChild(cards);

        var meter = h('div', 'cs-meter');
        meter.style.setProperty('--pct', Math.round(r.equity * 100));
        meter.appendChild(h('i'));
        meter.title = Math.round(r.equity * 100) + '% equity';
        row.appendChild(meter);
        row.appendChild(h('div', 'cs-pct', Math.round(r.equity * 100) + '%'));
        card.appendChild(row);
      }
      if (!rows.length) {
        card.appendChild(h('div', 'cs-row', h('span', 'cs-row-name', 'no opponents')));
      }
    }

    if (predict) {
      var prow = h('div', 'cs-row');
      var pnm = h('div', 'cs-row-name');
      pnm.appendChild(document.createTextNode(predict.name));
      pnm.appendChild(h('em', null, ' ' + predict.call));
      prow.appendChild(pnm);
      prow.appendChild(h('div', 'cs-tag ' + actionClass(predict.actionId), predict.action));
      card.appendChild(prow);

      var spread = h('div', 'cs-row');
      var s = h('div', 'cs-row-name');
      for (var d = 0; d < predict.distribution.length; d++) {
        var part = predict.distribution[d];
        s.appendChild(h('span', 'cs-tag ' + actionClass(part.id), part.action + ' ' + part.n + '%'));
      }
      spread.appendChild(s);
      card.appendChild(spread);
    }

    el.hud.appendChild(card);
  }

  /** CSS modifier for an action id; unknown ids read as a fold. */
  function actionClass(id) {
    return ACTION_CLASS[id] || 'fold';
  }

  // ================================================================= layout ==

  // The overlay is corner-anchored, so sizing off the canvas is enough; the
  // fallbacks keep it usable if the canvas has not been created yet.
  function fit() {
    var ref = document.querySelector('canvas')
      || document.getElementById('gamePlace')
      || document.body;
    var w = ref.clientWidth || window.innerWidth;
    if (!w) return false;
    // Must land on the document element: shop.css derives --panel-w, --radius
    // and --shadow from --u on :root, and those substitute once, where they are
    // declared. Setting --u only on the overlay would leave them stuck at 1px.
    document.documentElement.style.setProperty('--u', (w / 1000) + 'px');
    return true;
  }

  function forceRetick() {
    // option changes that only take effect via handleTurn replacement
    if (state.owned.mind) lastStatus.mind = ITEMS_BY_ID.mind.tick(context()) || '';
    engineTick();
  }

  // =================================================================== boot ==

  function boot() {
    load();
    build();
    fit();
    window.addEventListener('resize', fit);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (ui.picker) closePicker();
        else if (ui.open) closePanel();
      }
    });
    setInterval(function () {
      // re-fit until we have a real reference, and whenever the window changes
      if (!ui.fitted && fit()) ui.fitted = true;
      engineTick();
      if (ui.credits !== state.credits) {
        ui.credits = state.credits;
        el.cred.textContent = state.credits + ' CRED';
        el.cred2.textContent = state.credits + ' CRED';
        if (ui.open) {
          for (var i = 0; i < el.grid.children.length; i++) {
            var foot = el.grid.children[i].querySelector('.cs-item-foot');
            if (!foot) continue;
            var price = foot.querySelector('.cs-price');
            if (price && /CRED$/.test(price.textContent)) continue;
            var btn = foot.querySelector('.cs-btn');
            if (!btn || btn.textContent !== 'Short') continue;
            if (state.credits >= ITEMS[i].price) renderPanel();
          }
        }
      }
    }, 90);
  }

  // Expose a tiny surface for the mockup harness and for console tinkering.
  window.CheatShop = {
    items: ITEMS,
    state: state,
    equity: equity,
    evaluate: evaluate,
    cardLabel: cardLabel,
    reindex: function () { ITEMS.forEach(function (it) { ITEM_BY_ID[it.id] = it; }); },
    open: openPanel,
    close: closePanel,
    tick: engineTick,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();