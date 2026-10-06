/**
 * The Trader — Seed script
 * Populates: demo user + VNDIRECT account, VN30 instruments, quotes,
 * 90-day price history, 23 agents (roster src/lib/agent-roster.ts) + runs/
 * messages/tasks, signals, orders/trades/positions, risk alerts, watchlist.
 * Run: bun prisma/seed.ts
 */
import { PrismaClient } from '@prisma/client'
import { AGENT_ROSTER } from '../src/lib/agent-roster'

const db = new PrismaClient()

// Deterministic PRNG for reproducible seed data
let seedState = 42
function rand() {
  seedState = (seedState * 1103515245 + 12345) % 2147483648
  return seedState / 2147483648
}
function randInt(min: number, max: number) {
  return Math.floor(rand() * (max - min + 1)) + min
}
function round100(v: number) {
  return Math.round(v / 100) * 100
}

type StockDef = {
  symbol: string
  name: string
  sector: string
  price: number // reference price (VND)
  vol: number // daily volatility fraction
  volBase: number // base daily volume (shares)
}

const STOCKS: StockDef[] = [
  { symbol: 'VCB', name: 'Ngân hàng TMCP Ngoại thương Việt Nam', sector: 'Ngân hàng', price: 91500, vol: 0.012, volBase: 1_800_000 },
  { symbol: 'BID', name: 'Ngân hàng TMCP Đầu tư và Phát triển VN', sector: 'Ngân hàng', price: 38800, vol: 0.014, volBase: 3_200_000 },
  { symbol: 'CTG', name: 'Ngân hàng TMCP Công thương Việt Nam', sector: 'Ngân hàng', price: 34600, vol: 0.016, volBase: 4_500_000 },
  { symbol: 'TCB', name: 'Ngân hàng TMCP Kỹ thương Việt Nam', sector: 'Ngân hàng', price: 29200, vol: 0.018, volBase: 5_600_000 },
  { symbol: 'VPB', name: 'Ngân hàng TMCP Việt Nam Thịnh Vượng', sector: 'Ngân hàng', price: 22100, vol: 0.02, volBase: 8_400_000 },
  { symbol: 'VIC', name: 'Tổng công ty CP Đầu tư và Kinh doanh nhà Vingroup', sector: 'Bất động sản', price: 74600, vol: 0.017, volBase: 1_100_000 },
  { symbol: 'VHM', name: 'Công ty CP Vinhomes', sector: 'Bất động sản', price: 43200, vol: 0.019, volBase: 2_700_000 },
  { symbol: 'VRE', name: 'Công ty CP Vincom Retail', sector: 'Bất động sản', price: 18600, vol: 0.018, volBase: 1_900_000 },
  { symbol: 'FPT', name: 'Công ty CP FPT', sector: 'Công nghệ', price: 138700, vol: 0.016, volBase: 1_500_000 },
  { symbol: 'CMG', name: 'Công ty CP Công nghệ CMG', sector: 'Công nghệ', price: 16800, vol: 0.019, volBase: 900_000 },
  { symbol: 'HPG', name: 'Công ty CP Tập đoàn Hòa Phát', sector: 'Vật liệu', price: 27900, vol: 0.018, volBase: 5_100_000 },
  { symbol: 'HSG', name: 'Công ty CP Tập đoàn Hoa Sen', sector: 'Vật liệu', price: 18900, vol: 0.021, volBase: 2_300_000 },
  { symbol: 'MSN', name: 'Công ty CP Masan Group', sector: 'Tiêu dùng', price: 74800, vol: 0.015, volBase: 950_000 },
  { symbol: 'MWG', name: 'Công ty CP Đầu tư Thế Giới Di Động', sector: 'Bán lẻ', price: 64900, vol: 0.02, volBase: 1_400_000 },
  { symbol: 'VNM', name: 'Công ty CP Sữa Việt Nam', sector: 'Tiêu dùng', price: 65700, vol: 0.011, volBase: 1_200_000 },
  { symbol: 'SAB', name: 'Công ty CP Bia - Rượu - NGK Sài Gòn', sector: 'Tiêu dùng', price: 42600, vol: 0.013, volBase: 700_000 },
  { symbol: 'GAS', name: 'Tổng công ty Khí Việt Nam', sector: 'Năng lượng', price: 73500, vol: 0.012, volBase: 850_000 },
  { symbol: 'PLX', name: 'Tổng công ty CP Xăng dầu Việt Nam', sector: 'Năng lượng', price: 38200, vol: 0.016, volBase: 1_300_000 },
  { symbol: 'VJC', name: 'Tổng công ty CP Hàng không Việt Nam', sector: 'Hàng không', price: 103500, vol: 0.014, volBase: 480_000 },
  { symbol: 'HVN', name: 'Tổng công ty Hàng không Việt Nam', sector: 'Hàng không', price: 29700, vol: 0.02, volBase: 2_100_000 },
  { symbol: 'MBB', name: 'Ngân hàng TMCP Quân đội', sector: 'Ngân hàng', price: 26800, vol: 0.017, volBase: 3_400_000 },
  { symbol: 'STB', name: 'Ngân hàng TMCP Sài Gòn Thương Tín', sector: 'Ngân hàng', price: 41500, vol: 0.018, volBase: 3_900_000 },
  { symbol: 'PNJ', name: 'Công ty CP Vàng bạc Đá quý Phú Nhuận', sector: 'Bán lẻ', price: 94800, vol: 0.014, volBase: 620_000 },
  { symbol: 'DHG', name: 'Công ty CP Dược Hậu Giang', sector: 'Y tế', price: 106200, vol: 0.012, volBase: 320_000 },
  { symbol: 'VIB', name: 'Ngân hàng TMCP Quốc tế Việt Nam', sector: 'Ngân hàng', price: 20600, vol: 0.019, volBase: 4_100_000 },
  { symbol: 'TPB', name: 'Ngân hàng TMCP Tiên Phong', sector: 'Ngân hàng', price: 15300, vol: 0.021, volBase: 5_800_000 },
  { symbol: 'SHB', name: 'Ngân hàng TMCP Sài Gòn - Hà Nội', sector: 'Ngân hàng', price: 11600, vol: 0.022, volBase: 9_200_000 },
  { symbol: 'SSI', name: 'Công ty CP Chứng khoán SSI', sector: 'Chứng khoán', price: 33800, vol: 0.019, volBase: 2_800_000 },
  { symbol: 'VND', name: 'Công ty CP Chứng khoán VNDIRECT', sector: 'Chứng khoán', price: 16800, vol: 0.024, volBase: 3_600_000 },
  { symbol: 'HCM', name: 'Công ty CP Chứng khoán TP.HCM', sector: 'Chứng khoán', price: 28900, vol: 0.021, volBase: 1_700_000 },
]

// 23 agents — nguồn duy nhất: src/lib/agent-roster.ts (code/name/role/group/
// description/config); model mặc định space-bunny-free (runtime đọc từ llm.ts)
const AGENTS = AGENT_ROSTER.map((a) => ({
  code: a.code,
  name: a.name,
  role: a.role as never,
  group: a.group,
  description: a.description,
  config: JSON.stringify(a.config),
}))

// Generate 90 trading days (skip weekends), most recent first is NOT required — generate ascending then reverse
function generateBars(def: StockDef, days = 90) {
  const bars: { date: Date; open: number; high: number; low: number; close: number; volume: number; value: number }[] = []
  // random walk backwards from reference price: we generate forward from a start price
  // such that the last close ≈ def.price
  let price = def.price * (1 - (rand() - 0.5) * 0.1) // start ±5%
  const dates: Date[] = []
  const cursor = new Date()
  cursor.setHours(15, 0, 0, 0)
  while (dates.length < days) {
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) dates.push(new Date(cursor))
    cursor.setDate(cursor.getDate() - 1)
  }
  dates.reverse()
  for (const date of dates) {
    const drift = (def.price - price) * 0.02 // mean reversion toward reference
    const shock = (rand() - 0.5) * 2 * def.vol
    const open = price
    const close = Math.max(1000, price * (1 + shock) + drift)
    const high = Math.max(open, close) * (1 + rand() * def.vol * 0.6)
    const low = Math.min(open, close) * (1 - rand() * def.vol * 0.6)
    const volume = Math.round(def.volBase * (0.6 + rand() * 0.9))
    // F-101 (audit 19-a): mọi giá OHLC nằm trong dải ±7% so close hôm trước (Q2 HOSE)
    const bandHigh = round100(price * 1.07)
    const bandLow = round100(price * 0.93)
    const openC = Math.min(Math.max(round100(open), bandLow), bandHigh)
    const closeC = Math.min(Math.max(round100(close), bandLow), bandHigh)
    const highC = Math.min(bandHigh, Math.max(round100(high), openC, closeC))
    const lowC = Math.max(bandLow, Math.min(round100(low), openC, closeC))
    bars.push({
      date,
      open: openC,
      high: highC,
      low: lowC,
      close: closeC,
      volume,
      value: volume * closeC,
    })
    price = closeC
  }
  // Force last close to reference price for consistency with quotes
  // (F-101 audit 19-a: kéo về sát def.price NHƯNG luôn trong dải ±7% so close hôm trước)
  const last = bars[bars.length - 1]
  const prevClose = bars[bars.length - 2].close
  const bandHigh = round100(prevClose * 1.07)
  const bandLow = round100(prevClose * 0.93)
  const clamp = (v: number) => Math.min(Math.max(v, bandLow), bandHigh)
  const adj = clamp(round100(def.price))
  last.close = adj
  last.open = clamp(round100(adj * (1 - (rand() - 0.5) * 0.006)))
  last.high = Math.min(bandHigh, round100(Math.max(last.open, adj) * (1 + rand() * def.vol * 0.4)))
  last.low = Math.max(bandLow, round100(Math.min(last.open, adj) * (1 - rand() * def.vol * 0.4)))
  return bars
}

async function main() {
  console.log('🌱 Seeding The Trader database...')

  // Clean slate
  await db.auditLog.deleteMany()
  await db.riskAlert.deleteMany()
  await db.trade.deleteMany()
  await db.order.deleteMany()
  await db.position.deleteMany()
  await db.signal.deleteMany()
  await db.agentMessage.deleteMany()
  await db.agentTask.deleteMany()
  await db.agentRun.deleteMany()
  await db.agent.deleteMany()
  await db.watchlistItem.deleteMany()
  await db.watchlist.deleteMany()
  await db.bar.deleteMany()
  await db.quote.deleteMany()
  await db.instrument.deleteMany()
  await db.brokerAccount.deleteMany()
  await db.user.deleteMany()

  // ── User + VNDIRECT broker account ────────────────────────────
  const user = await db.user.create({
    data: {
      email: 'trader@thetrader.vn',
      name: 'Nguyễn Văn Trader',
      passwordHash: 'demo-not-a-real-hash',
      phone: '0901234567',
      role: 'trader',
    },
  })
  const account = await db.brokerAccount.create({
    data: {
      userId: user.id,
      broker: 'VNDIRECT',
      accountNumber: 'VD0029961828',
      accountType: 'margin',
      cashBalance: 486_500_000,
      equity: 1_284_300_000,
      marginUsed: 92_000_000,
      status: 'ACTIVE',
    },
  })

  // ── Instruments + 90-day bars + latest quote ──────────────────
  const instruments: { id: string; symbol: string; def: StockDef; lastBar: { close: number; date: Date } }[] = []
  for (const def of STOCKS) {
    const inst = await db.instrument.create({
      data: {
        symbol: def.symbol,
        name: def.name,
        market: ['VCB', 'BID', 'CTG', 'TCB', 'VPB', 'VIC', 'VHM', 'VRE', 'FPT', 'CMG', 'HPG', 'HSG', 'MSN', 'MWG', 'VNM', 'SAB', 'GAS', 'PLX', 'VJC', 'MBB', 'STB', 'PNJ', 'DHG', 'VIB', 'TPB', 'SHB', 'SSI', 'VND', 'HCM'].includes(def.symbol)
          ? 'HOSE'
          : 'HOSE',
        type: 'STOCK',
        sector: def.sector,
        outstandingShares: randInt(300, 5000) * 1_000_000,
      },
    })
    const bars = generateBars(def, 90)
    await db.bar.createMany({
      data: bars.map((b) => ({ ...b, instrumentId: inst.id })),
    })
    const last = bars[bars.length - 1]
    const prev = bars[bars.length - 2]
    const change = last.close - prev.close
    const changePct = (change / prev.close) * 100
    await db.quote.create({
      data: {
        instrumentId: inst.id,
        open: last.open,
        high: last.high,
        low: last.low,
        last: last.close,
        volume: last.volume,
        bidPrice: round100(last.close * 0.999),
        bidVolume: randInt(5, 60) * 100,
        askPrice: round100(last.close * 1.001),
        askVolume: randInt(5, 60) * 100,
        change,
        changePct: Math.round(changePct * 100) / 100,
        refPrice: prev.close,
        ceilingPrice: round100(prev.close * 1.07),
        floorPrice: round100(prev.close * 0.93),
        tradedAt: new Date(),
      },
    })
    instruments.push({ id: inst.id, symbol: def.symbol, def, lastBar: { close: last.close, date: last.date } })
  }
  console.log(`  ✓ ${instruments.length} instruments, ${instruments.length * 90} bars, ${instruments.length} quotes`)

  // ── Agents ────────────────────────────────────────────────────
  const agentMap: Record<string, string> = {}
  for (const a of AGENTS) {
    const agent = await db.agent.create({
      data: {
        ...a,
        model: 'space-bunny-free',
        status: a.code === 'news-sentiment' ? 'RUNNING' : 'IDLE',
        healthScore: randInt(88, 100),
        lastRunAt: new Date(Date.now() - randInt(2, 55) * 60_000),
      },
    })
    agentMap[a.code] = agent.id
  }

  // ── Agent runs (history) ──────────────────────────────────────
  for (const a of AGENTS) {
    for (let i = 0; i < 6; i++) {
      const startedAt = new Date(Date.now() - (i * 3 + randInt(1, 3)) * 3_600_000)
      const durationMs = randInt(800, 45000)
      const ok = rand() > 0.12
      await db.agentRun.create({
        data: {
          agentId: agentMap[a.code],
          taskStatus: ok ? 'COMPLETED' : 'FAILED',
          startedAt,
          finishedAt: new Date(startedAt.getTime() + durationMs),
          durationMs,
          tokensIn: randInt(1200, 48000),
          tokensOut: randInt(300, 6000),
          costUsd: Math.round(rand() * 0.42 * 1000) / 1000,
          output: ok ? JSON.stringify({ summary: `Chu kỳ phân tích #${6 - i} hoàn tất`, confidence: randInt(55, 95) }) : null,
          error: ok ? null : 'Timeout khi thu thập dữ liệu nguồn ngoài',
        },
      })
    }
  }

  // ── Agent tasks ───────────────────────────────────────────────
  const tasks = [
    { agent: 'market-analyst', title: 'Quét kỹ thuật VN30 phiên hôm nay', status: 'COMPLETED', priority: 'high' },
    { agent: 'market-analyst', title: 'Cập nhật chỉ báo RSI/MACD cho watchlist', status: 'RUNNING', priority: 'medium' },
    { agent: 'news-sentiment', title: 'Tổng hợp tin tức sáng nay (CafeF, VnEconomy)', status: 'RUNNING', priority: 'high' },
    { agent: 'news-sentiment', title: 'Đánh giá cảm xúc thị trường tuần này', status: 'PENDING', priority: 'low' },
    { agent: 'risk-manager', title: 'Kiểm tra giới hạn drawdown danh mục', status: 'COMPLETED', priority: 'high' },
    { agent: 'risk-manager', title: 'Đối chiếu tỷ trọng ngành với giới hạn 40%', status: 'PENDING', priority: 'medium' },
    { agent: 'portfolio-strategist', title: 'Đề xuất phân bổ lại danh mục Q4', status: 'COMPLETED', priority: 'high' },
    { agent: 'execution-manager', title: 'Theo dõi lệnh VCB còn lại', status: 'RUNNING', priority: 'medium' },
    { agent: 'execution-manager', title: 'Báo cáo khớp lệnh cuối ngày', status: 'PENDING', priority: 'low' },
  ]
  for (const t of tasks) {
    await db.agentTask.create({
      data: {
        agentId: agentMap[t.agent],
        title: t.title,
        status: t.status as 'COMPLETED' | 'RUNNING' | 'PENDING',
        priority: t.priority,
        completedAt: t.status === 'COMPLETED' ? new Date(Date.now() - randInt(1, 8) * 3_600_000) : null,
        result: t.status === 'COMPLETED' ? JSON.stringify({ ok: true }) : null,
      },
    })
  }

  // ── Agent messages (recent conversation) ──────────────────────
  const messages: { from: string; content: string; reasoning?: string; sentiment?: string; minutesAgo: number }[] = [
    {
      from: 'market-analyst',
      content:
        'VN30 phá vỡ vùng kháng cự 1,290 điểm với khối lượngGreaterThan phiên trước 18%. RSI14 nhóm ngân hàng đang ở vùng 58-62, còn dư địa. FPT tạo mô hình uptrend rõ rệt, MACD cắt lên đường tín hiệu.',
      reasoning: 'SMA20 > SMA50 trên 21/30 mã; khối lượng xác nhận xu hướng tăng.',
      minutesAgo: 42,
    },
    {
      from: 'news-sentiment',
      content:
        'Tin tích cực: Fed giữ nguyên lãi suất, DXY giảm nhẹ → dòng vốn có thể quay lại thị trường mới nổi. CaféF đưa tin dòng tiền khối ngoại ròng dương 3 phiên liên tiếp tại HOSE. Nguy hiểm: tin đồn siết room ngành BĐS cần theo dõi.',
      sentiment: 'bullish',
      reasoning: 'Chấm điểm cảm xúc tổng hợp: +0.62 (thang -1..1) trên 47 bài báo.',
      minutesAgo: 35,
    },
    {
      from: 'risk-manager',
      content:
        'Cảnh báo: tỷ trọng ngành Ngân hàng đang chiếm 42% NAV, vượt giới hạn 40%. Drawdown danh mục hiện -4.8% (giới hạn -15%). Đề xuất: không mở thêm vị thế ngân hàng, cân nhắc chốt lời một phần TCB.',
      reasoning: 'Breach policy: sector_weight=42% > max 40%.',
      minutesAgo: 28,
    },
    {
      from: 'portfolio-strategist',
      content:
        'Tổng hợp: giữ 60% vốn đầu tư, 40% tiền mặt. Ưu tiên FPT (công nghệ, xu hướng mạnh), giảm dần TCB (vượt tỷ trọng). Mục tiêu 8 vị thế, mỗi vị thế tối đa 25% NAV. Chờ xác nhận của Risk Manager trước khi thực thi.',
      reasoning: 'Composite score: FPT 84/100, VCB 76/100, HPG 71/100.',
      minutesAgo: 21,
    },
    {
      from: 'execution-manager',
      content:
        'Nhận kế hoạch: đặt lệnh BUY FPT LIMIT 139,000 × 500 cp (tách 3 lệnh nhỏ tránh trượt giá). Lệnh 1 đã khớp 200cp @138,700. Tiếp tục theo dõi biến động 15 phút để đẩy lệnh 2.',
      reasoning: 'Thanh khoản FPT đạt 1.5 triệu cp/phiên, đủ tách lệnh.',
      minutesAgo: 12,
    },
  ]
  for (const m of messages) {
    await db.agentMessage.create({
      data: {
        fromAgentId: agentMap[m.from],
        broadcast: true,
        content: m.content,
        reasoning: m.reasoning ?? null,
        sentiment: m.sentiment ?? null,
        createdAt: new Date(Date.now() - m.minutesAgo * 60_000),
      },
    })
  }

  // ── Signals ───────────────────────────────────────────────────
  const signalDefs: { symbol: string; direction: 'BUY' | 'SELL' | 'HOLD'; confidence: 'LOW' | 'MEDIUM' | 'HIGH'; score: number; rationale: string; agent: string }[] = [
    { symbol: 'FPT', direction: 'BUY', confidence: 'HIGH', score: 84, rationale: 'MACD cắt lên + uptrend + khối ngoại mua ròng. Mục tiêu 148,200, dừng lỗ 131,800.', agent: 'portfolio-strategist' },
    { symbol: 'VCB', direction: 'BUY', confidence: 'MEDIUM', score: 76, rationale: 'Vượt SMA50 với khối lượng xác nhận, vùng hỗ trợ 89,000 chắc chắn.', agent: 'market-analyst' },
    { symbol: 'HPG', direction: 'BUY', confidence: 'MEDIUM', score: 71, rationale: 'Giá thép HRC hồi phục, P/B 1.1x dưới trung bình 5 năm.', agent: 'market-analyst' },
    { symbol: 'TCB', direction: 'SELL', confidence: 'MEDIUM', score: 63, rationale: 'Tỷ trọng ngành ngân hàng vượt giới hạn 40% — giảm vị thế theo policy.', agent: 'risk-manager' },
    { symbol: 'MWG', direction: 'HOLD', confidence: 'LOW', score: 52, rationale: 'Đảo chiều trong tam giác tích lũy, chờ breakout khối lượng.', agent: 'market-analyst' },
    { symbol: 'VNM', direction: 'HOLD', confidence: 'LOW', score: 48, rationale: 'Thanh khoản thấp, chờ báo cáo Q4 trước khi đánh giá lại.', agent: 'portfolio-strategist' },
    { symbol: 'SSI', direction: 'BUY', confidence: 'MEDIUM', score: 68, rationale: 'Khối ngoại mua ròng 3 phiên, vượt kháng cự ngắn hạn 33,500.', agent: 'news-sentiment' },
    { symbol: 'HSG', direction: 'SELL', confidence: 'LOW', score: 44, rationale: 'Biên lợi nhuận mỏng, rủi ro thuế chống bán phá giá Mỹ.', agent: 'news-sentiment' },
  ]
  const signalMap: Record<string, string> = {}
  for (const s of signalDefs) {
    const inst = instruments.find((i) => i.symbol === s.symbol)!
    const signal = await db.signal.create({
      data: {
        instrumentId: inst.id,
        direction: s.direction,
        confidence: s.confidence,
        score: s.score,
        rationale: s.rationale,
        agentId: agentMap[s.agent],
        targetPrice: s.direction === 'BUY' ? round100(inst.lastBar.close * 1.08) : s.direction === 'SELL' ? round100(inst.lastBar.close * 0.94) : null,
        stopLoss: s.direction === 'BUY' ? round100(inst.lastBar.close * 0.95) : null,
        takeProfit: s.direction === 'BUY' ? round100(inst.lastBar.close * 1.12) : null,
        expiresAt: new Date(Date.now() + 3 * 86400_000),
        createdAt: new Date(Date.now() - randInt(1, 6) * 3_600_000),
      },
    })
    signalMap[s.symbol] = signal.id
  }

  // ── Positions ─────────────────────────────────────────────────
  const positionDefs: { symbol: string; qty: number; avgPrice: number }[] = [
    { symbol: 'VCB', qty: 3000, avgPrice: 86500 },
    { symbol: 'FPT', qty: 700, avgPrice: 124500 },
    { symbol: 'TCB', qty: 8000, avgPrice: 31100 },
    { symbol: 'HPG', qty: 6000, avgPrice: 25400 },
    { symbol: 'MWG', qty: 1500, avgPrice: 67200 },
    { symbol: 'SSI', qty: 4000, avgPrice: 31200 },
    { symbol: 'VHM', qty: 2000, avgPrice: 45800 },
  ]
  for (const p of positionDefs) {
    const inst = instruments.find((i) => i.symbol === p.symbol)!
    const last = inst.lastBar.close
    const realized = p.symbol === 'VHM' ? -1_240_000 : randInt(-3, 18) * 1_000_000
    await db.position.create({
      data: {
        brokerAccountId: account.id,
        instrumentId: inst.id,
        quantity: p.qty,
        avgPrice: p.avgPrice,
        realizedPnl: realized,
        status: 'OPEN',
        openedAt: new Date(Date.now() - randInt(10, 80) * 86400_000),
      },
    })
    void last
  }

  // ── Orders + trades (recent activity) ─────────────────────────
  const orderDefs: {
    symbol: string
    side: 'BUY' | 'SELL'
    qty: number
    price: number
    status: 'FILLED' | 'PARTIALLY_FILLED' | 'SUBMITTED' | 'CANCELLED'
    filledQty: number
    hoursAgo: number
    useSignal?: boolean
  }[] = [
    { symbol: 'FPT', side: 'BUY', qty: 500, price: 139000, status: 'PARTIALLY_FILLED', filledQty: 200, hoursAgo: 1, useSignal: true },
    { symbol: 'VCB', side: 'BUY', qty: 1000, price: 91000, status: 'FILLED', filledQty: 1000, hoursAgo: 3, useSignal: true },
    { symbol: 'TCB', side: 'SELL', qty: 2000, price: 29500, status: 'SUBMITTED', filledQty: 0, hoursAgo: 2, useSignal: true },
    { symbol: 'HPG', side: 'BUY', qty: 3000, price: 27700, status: 'FILLED', filledQty: 3000, hoursAgo: 26, useSignal: true },
    { symbol: 'MWG', side: 'BUY', qty: 500, price: 64500, status: 'CANCELLED', filledQty: 0, hoursAgo: 30 },
    { symbol: 'SSI', side: 'BUY', qty: 2000, price: 33500, status: 'FILLED', filledQty: 2000, hoursAgo: 49, useSignal: true },
    { symbol: 'VHM', side: 'SELL', qty: 1500, price: 43500, status: 'FILLED', filledQty: 1500, hoursAgo: 73 },
  ]
  for (const o of orderDefs) {
    const inst = instruments.find((i) => i.symbol === o.symbol)!
    const createdAt = new Date(Date.now() - o.hoursAgo * 3_600_000)
    const order = await db.order.create({
      data: {
        userId: user.id,
        brokerAccountId: account.id,
        signalId: o.useSignal ? signalMap[o.symbol] : null,
        instrumentId: inst.id,
        side: o.side,
        type: 'LIMIT',
        quantity: o.qty,
        price: o.price,
        filledQuantity: o.filledQty,
        avgFillPrice: o.filledQty > 0 ? round100(o.price * (0.998 + rand() * 0.004)) : null,
        status: o.status,
        fee: o.filledQty > 0 ? Math.round(o.filledQty * o.price * 0.0015) : 0,
        note: o.useSignal ? 'Tự động từ tín hiệu agent' : 'Thủ công',
        submittedAt: createdAt,
        filledAt: o.status === 'FILLED' ? new Date(createdAt.getTime() + randInt(5, 50) * 60_000) : null,
        createdAt,
      },
    })
    if (o.filledQty > 0) {
      const fillPrice = order.avgFillPrice ?? o.price
      await db.trade.create({
        data: {
          orderId: order.id,
          instrumentId: inst.id,
          side: o.side,
          quantity: o.filledQty,
          price: fillPrice,
          fee: Math.round(o.filledQty * fillPrice * 0.0015),
          tax: o.side === 'SELL' ? Math.round(o.filledQty * fillPrice * 0.001) : 0,
          executedAt: order.filledAt ?? createdAt,
        },
      })
    }
  }

  // ── Risk alerts ───────────────────────────────────────────────
  const alerts: { severity: 'INFO' | 'WARNING' | 'CRITICAL'; code: string; message: string; metricKey: string; metricValue: number; threshold: number; hoursAgo: number }[] = [
    { severity: 'WARNING', code: 'RISK_SECTOR_WEIGHT', message: 'Tỷ trọng ngành Ngân hàng vượt giới hạn: 42% > 40% NAV', metricKey: 'portfolio.sector_weight.banking', metricValue: 42, threshold: 40, hoursAgo: 1 },
    { severity: 'CRITICAL', code: 'RISK_POSITION_LOSS', message: 'VHM lỗ âm sâu -5.4% so với giá vốn bình quân', metricKey: 'position.unrealized_pnl_pct.VHM', metricValue: -5.4, threshold: -5, hoursAgo: 4 },
    { severity: 'INFO', code: 'RISK_REBALANCE_DUE', message: 'Danh mục lệch tỷ trọng mục tiêu >5% — cần cân bằng lại', metricKey: 'portfolio.rebalance_deviation', metricValue: 6.8, threshold: 5, hoursAgo: 22 },
  ]
  for (const a of alerts) {
    await db.riskAlert.create({
      data: {
        severity: a.severity,
        code: a.code,
        message: a.message,
        metricKey: a.metricKey,
        metricValue: a.metricValue,
        threshold: a.threshold,
        createdAt: new Date(Date.now() - a.hoursAgo * 3_600_000),
      },
    })
  }

  // ── Audit logs ────────────────────────────────────────────────
  const audits: { action: string; entity: string; hoursAgo: number }[] = [
    { action: 'ORDER_CREATED', entity: 'Order', hoursAgo: 1 },
    { action: 'SIGNAL_APPROVED', entity: 'Signal', hoursAgo: 1 },
    { action: 'ORDER_FILLED', entity: 'Order', hoursAgo: 3 },
    { action: 'RISK_ALERT_RAISED', entity: 'RiskAlert', hoursAgo: 4 },
    { action: 'AGENT_RUN_COMPLETED', entity: 'AgentRun', hoursAgo: 6 },
    { action: 'ORDER_CANCELLED', entity: 'Order', hoursAgo: 30 },
  ]
  for (const a of audits) {
    await db.auditLog.create({
      data: {
        userId: user.id,
        action: a.action,
        entity: a.entity,
        entityId: null,
        after: JSON.stringify({ seeded: true }),
        ip: '127.0.0.1',
        createdAt: new Date(Date.now() - a.hoursAgo * 3_600_000),
      },
    })
  }

  // ── Watchlist ─────────────────────────────────────────────────
  const watchlist = await db.watchlist.create({
    data: { userId: user.id, name: 'VN30 tiêu điểm', isDefault: true },
  })
  for (const sym of ['VCB', 'FPT', 'HPG', 'TCB', 'MWG', 'SSI', 'VHM', 'VND']) {
    const inst = instruments.find((i) => i.symbol === sym)!
    await db.watchlistItem.create({ data: { watchlistId: watchlist.id, instrumentId: inst.id } })
  }

  console.log('✅ Seed complete.')
  console.log(`   User: ${user.email} | Account: VNDIRECT ${account.accountNumber}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
