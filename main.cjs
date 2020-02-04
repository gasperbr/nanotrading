/* import dotenv from 'dotenv';
import cron from 'cron';
import binance from 'binance-api-node';
dotenv.config();
const CronJob = cron.CronJob;
const Binance = binance; */
require('dotenv').config();
const CronJob = require('cron').CronJob;
const Binance = require('binance-api-node').default;

const environment = {
	apiSecret: process.env.BINANCE_API_SECRET,
	apiKey: process.env.BINANCE_API,
	profitPercentMin: float(process.env.PROFIT_PERCENT_MIN),
	profitPercentMax: float(process.env.PROFIT_PERCENT_MAX),
	sellSpreadMax: float(process.env.SELL_SPREAD_MAX),
	everyXHours: int(process.env.EVERY_X_HOURS),
	minOrderUsdt: float(process.env.MIN_ORDER_USDT),
	minOrderPercent: int(process.env.MIN_ORDER_SIZE_OF_CURRENT_BALANCE),
	priceDecimals: int(process.env.PRICE_DECIMALS),
	nanoDecimals: int(process.env.NANO_AMOUNT_DECIMALS)
}

const client = Binance({
  apiKey: environment.apiKey,
  apiSecret: environment.apiSecret,
});

let sellExtraNanosOnNextRound = {
	amount: 0,
	boughtAt: 0,
}

new CronJob('*/20 * * * *', function() {
  checkForEmptySellSide();
}, null, true, 'America/Los_Angeles');

function checkForEmptySellSide() {
	Promise.all([client.openOrders({symbol: 'NANOUSDT'}), getBook()]).then(array => {
		const sellOrders = (array[0] || []).filter(o => o.side === 'SELL').map(o => float(o.price));
		const book = array[1];

    if (sellOrders.length === 0) {
			console.log('no other orders, run bot');
			nanoUsdtBuySell();
		} else {
			let minOrderPrice = sellOrders[0];
			sellOrders.forEach(price => {
				if (price < minOrderPrice) {
					minOrderPrice = price; // get lowest sell order
				}
			});
			const percentDifference = (minOrderPrice / book.lowestAsk - 1) * 100;
			const maxDiff = environment.sellSpreadMax;
			if (percentDifference > maxDiff) {
        console.log(`difference lowest ask / my lowest sell (${percentDifference}) too low (max: ${maxDiff}), runnung bot`);
				nanoUsdtBuySell();
      }
		}
	}).catch(err => {
		console.log('could not check sell orders ', err);
	});
}

async function nanoUsdtBuySell() {
	
  const book = await getBook();
	if (book.usdtBalance < environment.minOrderUsdt) {
		return;
	}

	tryLimitOrder(book).then((order) => {
		if (order.status === 'FILLED') {

			console.log(`Bought ${order.executedQty} nanos @${order.price}  ($${order.executedQty * order.price})`);
			setLimitSellOrder(float(order.executedQty), float(order.price));

		} else if (order.status === 'PARTIALLY_FILLED') {

			console.log(`PARTIAL - Bought ${order.executedQty} nanos @${order.price}`);
			// might not have enough funds to do a market buy, no biggie
			cancelOrder(order).then(() => {
				console.log('canceled limit order');
				sellExtraNanosOnNextRound.amount += float(order.executedQty);
				sellExtraNanosOnNextRound.boughtAt = Math.max(float(order.price), sellExtraNanosOnNextRound.boughtAt);

				marketBuyAndSetLimitSell();
			
			}).catch((err) => {
				console.log('coudld no cancel limit order ', err)
				// dont have enough nano for this, get fucked
				// setLimitSellOrder(order.quantity, order.price);
			});

		} else {
			cancelOrder(order).then(() => {
				console.log('canceled limit order');
				marketBuyAndSetLimitSell();
			}).catch((msg) => {
				console.log('could not cancel limit order ', msg);
				// probably dont have enough nano for this, get fucked
				// setLimitSellOrder(order.quantity, order.price);
			});
		}
	}).catch((msg) => {
		console.log('could not execute limit order ', msg);
		marketBuyAndSetLimitSell();
	});
}

async function getBook() {
	const account = await client.accountInfo();
	const market = await client.book({ symbol: 'NANOUSDT', limit: 5 });
	return {
		lowestAsk: float(market.asks[0].price),
		lowestAskAmmount: float(market.asks[0].quantity),
		highestBid: float(market.bids[0].price),
		middlePrice: round((float(market.asks[0].price) + float(market.bids[0].price)) / 2, environment.priceDecimals, 'DOWN'),
		usdtBalance: float(account.balances.find(b => b.asset === 'USDT').free)
	}
}

function marketBuyAndSetLimitSell() {
	marketBuy().then((marketOrder) => {
		const price = getHighestFillPrice(marketOrder);
		console.log(`market bought ${marketOrder.executedQty} nanos @ ${price} ($${marketOrder.executedQty * price})`)
		setLimitSellOrder(float(marketOrder.executedQty), price);
	}).catch(err => {
		console.log('could not market buy', err);
	});
}

function getHighestFillPrice(marketOrder) {
	return float(marketOrder.fills.pop().price);
}

function getProfit(min=2, max=2) {
	const actualPercent = min + ((max - min) * Math.random());
	return (actualPercent + 100) / 100; // in form of 1.023
}

function setLimitSellOrder(nanoToSell, boughtAt) {
  const profit = getProfit(environment.profitPercentMin, environment.profitPercentMax);
	nanoToSell = round(nanoToSell * 0.999, environment.nanoDecimals); // keep 1c of nano
	let sellAt = round(boughtAt * profit, environment.priceDecimals);

	if (sellExtraNanosOnNextRound.amount > 0) {
		nanoToSell += sellExtraNanosOnNextRound.amount;
		sellAt = Math.max(sellAt, sellExtraNanosOnNextRound.boughtAt);
	}

	const orderData = {
		symbol: 'NANOUSDT',
		side: 'SELL',
		quantity: nanoToSell,
		price: sellAt,
	};
	client.order(orderData).then(order => {
		console.log(`set sell order @ ${sellAt} for ${nanoToSell} nanos ($${sellAt*nanoToSell}) - profit: ${profit}`);
		sellExtraNanosOnNextRound.amount = 0;
		sellExtraNanosOnNextRound.boughtAt = 0;
	}).catch(msg => {
		console.log('could not place sell order', orderData, msg);
	});
}

async function marketBuy() {
	const book = await getBook();
	const orderData = {
		symbol: 'NANOUSDT',
		side: 'BUY',
		quantity: getMarketBuyAmmount(book),
		type: 'MARKET'
	}
	return client.order(orderData);
}

function getMarketBuyAmmount(book) {
	const usdtAmmount = getUsdtBuyAmmount(book);
	let nanos = getNanosForPrice(book.lowestAsk, usdtAmmount, environment.nanoDecimals);
	return round(nanos, environment.nanoDecimals, 'UP'); 
}

function cancelOrder(order) {
	return client.cancelOrder({
		symbol: 'NANOUSDT',
		orderId: order.orderId,
	})
}

async function tryLimitOrder(book) {
	return new Promise(function(resolve, reject) {

		const usdtAmmount = getUsdtBuyAmmount(book);
		const orderData = {
			symbol: 'NANOUSDT',
			side: 'BUY',
			quantity: getNanosForPrice(book.middlePrice, usdtAmmount, environment.nanoDecimals),
			price: book.middlePrice,
		};
		client.order(orderData).then(order => {

			setTimeout(() => { // wait 15min and return order
				client.getOrder({
					symbol: 'NANOUSDT',
					orderId: order.orderId,
				}).then(resolve).catch(reject);
			}, 1000 * 60 * 15); // 15min

		}).catch(reject);
	});
}

function getNanosForPrice(price, usdt, nanoDecimals) {
	return round(usdt / price, nanoDecimals, 'UP');
}

function getUsdtBuyAmmount(book) {
	return Math.max(environment.minOrderUsdt, book.usdtBalance * environment.minOrderPercent / 100);
}

// HELPER FUNCTIONS

function int(number) {
	return parseInt(number, 10);
}

function float(number) {
	return parseFloat(number);
}

function round(number, decimals, direction = undefined) {
	const dPlaces = 10 ** decimals;
	if (direction === 'UP') {
		return Math.ceil(number * dPlaces) / dPlaces;	
	} else if (direction === 'DOWN') {
		return Math.floor(number * dPlaces) / dPlaces;
	} else {
		return Math.round(number * dPlaces) / dPlaces;
	}
}
