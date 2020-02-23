import React, { useState, useReducer, useEffect } from 'react'
import ReactGA from 'react-ga'
import { createBrowserHistory } from 'history'
import { ethers } from 'ethers'
import styled from 'styled-components'
import { useTranslation } from 'react-i18next'
import axios from 'axios';

import { Button } from '../../theme'
import { useWeb3React } from '../../hooks'
import CurrencyInputPanel from '../CurrencyInputPanel'
import AddressInputPanel from '../AddressInputPanel'
import OversizedPanel from '../OversizedPanel'
import TransactionDetails from '../TransactionDetails'
import ArrowDown from '../../assets/svg/SVGArrowDown'
import { amountFormatter, calculateGasMargin } from '../../utils'
import { useExchangeContract } from '../../hooks'
import { useTokenDetails } from '../../contexts/Tokens'
import { useTransactionAdder } from '../../contexts/Transactions'
import { useAddressBalance, useExchangeReserves } from '../../contexts/Balances'
import { useAddressAllowance } from '../../contexts/Allowances'
import { useWalletModalToggle } from '../../contexts/Application'
import { useETHPriceInUSD } from '../../contexts/Balances'
import { ZERO_EX_API_BASE_URL, ZERO_EX_API_ENDPTS, ZERO_EX_ASSET_PROXY_ADDRESSES, WETH_ADDRESS } from '../../constants';

const INPUT = 0
const OUTPUT = 1

const ETH_TO_TOKEN = 0
const TOKEN_TO_TOKEN = 2

// denominated in bips
const ALLOWED_SLIPPAGE_DEFAULT = 50
const TOKEN_ALLOWED_SLIPPAGE_DEFAULT = 50

// 15 minutes, denominated in seconds
const DEFAULT_DEADLINE_FROM_NOW = 60 * 15

// % above the calculated gas cost that we actually send, denominated in bips
const GAS_MARGIN = ethers.utils.bigNumberify(1000)

const DownArrowBackground = styled.div`
  ${({ theme }) => theme.flexRowNoWrap}
  justify-content: center;
  align-items: center;
`

const WrappedArrowDown = ({ clickable, active, ...rest }) => <ArrowDown {...rest} />
const DownArrow = styled(WrappedArrowDown)`
  color: ${({ theme, active }) => (active ? theme.royalBlue : theme.chaliceGray)};
  width: 0.625rem;
  height: 0.625rem;
  position: relative;
  padding: 0.875rem;
  cursor: ${({ clickable }) => clickable && 'pointer'};
`

const ExchangeRateWrapper = styled.div`
  ${({ theme }) => theme.flexRowNoWrap};
  align-items: center;
  color: ${({ theme }) => theme.doveGray};
  font-size: 0.75rem;
  padding: 0.5rem 1rem;
`

const ExchangeRate = styled.span`
  flex: 1 1 auto;
  width: 0;
  color: ${({ theme }) => theme.doveGray};
`

const Flex = styled.div`
  display: flex;
  justify-content: center;
  padding: 2rem;

  button {
    max-width: 20rem;
  }
`

function calculateSlippageBounds(value, token = false, tokenAllowedSlippage, allowedSlippage) {
  if (value) {
    const offset = value.mul(token ? tokenAllowedSlippage : allowedSlippage).div(ethers.utils.bigNumberify(10000))
    const minimum = value.sub(offset)
    const maximum = value.add(offset)
    return {
      minimum: minimum.lt(ethers.constants.Zero) ? ethers.constants.Zero : minimum,
      maximum: maximum.gt(ethers.constants.MaxUint256) ? ethers.constants.MaxUint256 : maximum
    }
  } else {
    return {}
  }
}

function getSwapType(inputCurrency, outputCurrency) {
  if (!inputCurrency || !outputCurrency) {
    return null
  } else if (inputCurrency === 'ETH') {
    return ETH_TO_TOKEN
  } else {
    return TOKEN_TO_TOKEN
  }
}

function getInitialSwapState(state) {
  const initialState = {
    independentValue: state.exactFieldURL && state.exactAmountURL ? state.exactAmountURL : '', // this is a user input
    dependentValue: '', // this is a calculated number
    independentField: state.exactFieldURL === 'output' ? OUTPUT : INPUT,
    inputCurrency: state.inputCurrencyURL ? state.inputCurrencyURL : 'ETH',
    outputCurrency: state.outputCurrencyURL
      ? state.outputCurrencyURL === 'ETH'
        ? state.inputCurrencyURL && state.inputCurrencyURL !== 'ETH'
          ? 'ETH'
          : ''
        : state.outputCurrencyURL
      : state.initialCurrency
      ? state.initialCurrency
      : '',
  }
  initialState.wasInputEth = initialState.inputCurrency === 'ETH'
  return initialState
}

function swapStateReducer(state, action) {
  switch (action.type) {
    case 'FLIP_INDEPENDENT': {
      const { independentField, inputCurrency, outputCurrency, wasInputEth } = state
      return {
        ...state,
        dependentValue: '',
        independentField: independentField === INPUT ? OUTPUT : INPUT,
        inputCurrency: outputCurrency === WETH_ADDRESS && wasInputEth ? 'ETH' : outputCurrency,
        outputCurrency: inputCurrency === 'ETH' ? WETH_ADDRESS : inputCurrency,
      }
    }
    case 'SELECT_CURRENCY': {
      const { inputCurrency, outputCurrency, wasInputEth } = state
      const { field, currency } = action.payload

      const newInputCurrency = field === INPUT ? currency : inputCurrency
      const newOutputCurrency = field === OUTPUT ? currency : outputCurrency

      if (newInputCurrency === newOutputCurrency) {
        return {
          ...state,
          inputCurrency: field === INPUT ? currency : '',
          outputCurrency: field === OUTPUT ? currency : '',
          wasInputEth: field === INPUT ? inputCurrency === 'ETH' : wasInputEth,
        }
      } else {
        return {
          ...state,
          inputCurrency: newInputCurrency,
          outputCurrency: newOutputCurrency,
          wasInputEth: field === INPUT ? inputCurrency === 'ETH' : wasInputEth,
        }
      }
    }
    case 'UPDATE_INDEPENDENT': {
      const { field, value } = action.payload
      const { dependentValue, independentValue } = state
      return {
        ...state,
        independentValue: value,
        dependentValue: value === independentValue ? dependentValue : '',
        independentField: field
      }
    }
    case 'UPDATE_DEPENDENT': {
      return {
        ...state,
        dependentValue: action.payload
      }
    }
    default: {
      return getInitialSwapState()
    }
  }
}

function getExchangeRate(inputValue, inputDecimals, outputValue, outputDecimals, invert = false) {
  try {
    if (
      inputValue &&
      (inputDecimals || inputDecimals === 0) &&
      outputValue &&
      (outputDecimals || outputDecimals === 0)
    ) {
      const factor = ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(18))

      if (invert) {
        return inputValue
          .mul(factor)
          .div(outputValue)
          .mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(outputDecimals)))
          .div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(inputDecimals)))
      } else {
        return outputValue
          .mul(factor)
          .div(inputValue)
          .mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(inputDecimals)))
          .div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(outputDecimals)))
      }
    }
  } catch {}
}

function getMarketRate(
  swapType,
  inputReserveETH,
  inputReserveToken,
  inputDecimals,
  outputReserveETH,
  outputReserveToken,
  outputDecimals,
  invert = false
) {
  if (swapType === ETH_TO_TOKEN) {
    return getExchangeRate(outputReserveETH, 18, outputReserveToken, outputDecimals, invert)
  } else if (swapType === TOKEN_TO_TOKEN) {
    const factor = ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(18))
    const firstRate = getExchangeRate(inputReserveToken, inputDecimals, inputReserveETH, 18)
    const secondRate = getExchangeRate(outputReserveETH, 18, outputReserveToken, outputDecimals)
    try {
      return !!(firstRate && secondRate) ? firstRate.mul(secondRate).div(factor) : undefined
    } catch {}
  }
}

async function fetchZeroExAPIQuoteAsync(sellToken, buyToken, amount, isBuy=true, account) {
  const res = await axios.get(`${ZERO_EX_API_BASE_URL}${ZERO_EX_API_ENDPTS.SWAP}`, {
    params: {
      sellToken,
      buyToken,
      takerAddress: account,
      buyAmount: isBuy ? amount.toString() : undefined,
      sellAmount: !isBuy ? amount.toString() : undefined,
    }
  });
  return res.data;
}

export default function ExchangePage({ initialCurrency, sending = false, params }) {
  const { t } = useTranslation()
  const { account, error, active, connector } = useWeb3React();

  const [ signerInstance, setSignerInstance ] = useState();

  useEffect(() => {
    connector.getProvider().then(provider => {
      const ethersProvider = new ethers.providers.Web3Provider(provider);
      const signer = ethersProvider.getSigner();
      setSignerInstance(signer);
    })
  }, [active, connector])


  // BigNumber.js instance
  const ethPrice = useETHPriceInUSD()

  const addTransaction = useTransactionAdder()

  // check if URL specifies valid slippage, if so use as default
  const initialSlippage = (token = false) => {
    let slippage = Number.parseInt(params.slippage)
    if (!isNaN(slippage) && (slippage === 0 || slippage >= 1)) {
      return slippage // round to match custom input availability
    }
    // check for token <-> token slippage option
    return token ? TOKEN_ALLOWED_SLIPPAGE_DEFAULT : ALLOWED_SLIPPAGE_DEFAULT
  }

  // check URL params for recipient, only on send page
  const initialRecipient = () => {
    if (sending && params.recipient) {
      return params.recipient
    }
    return ''
  }

  const [deadlineFromNow, setDeadlineFromNow] = useState(DEFAULT_DEADLINE_FROM_NOW)

  const [rawSlippage, setRawSlippage] = useState(() => initialSlippage())
  const [rawTokenSlippage, setRawTokenSlippage] = useState(() => initialSlippage(true))

  const allowedSlippageBig = ethers.utils.bigNumberify(rawSlippage)
  const tokenAllowedSlippageBig = ethers.utils.bigNumberify(rawTokenSlippage)

  // analytics
  useEffect(() => {
    ReactGA.pageview(window.location.pathname + window.location.search)
  }, [])

  // core swap state
  const [swapState, dispatchSwapState] = useReducer(
    swapStateReducer,
    {
      initialCurrency: initialCurrency,
      inputCurrencyURL: params.inputCurrency,
      outputCurrencyURL: params.outputCurrency,
      exactFieldURL: params.exactField,
      exactAmountURL: params.exactAmount
    },
    getInitialSwapState
  )

  const { independentValue, dependentValue, independentField, inputCurrency, outputCurrency } = swapState

  const [recipient, setRecipient] = useState({
    address: initialRecipient(),
    name: ''
  })
  const [recipientError, setRecipientError] = useState()

  // get swap type from the currency types
  const swapType = getSwapType(inputCurrency, outputCurrency)

  // get decimals and exchange address for each of the currency types
  const { symbol: inputSymbol, decimals: inputDecimals, exchangeAddress: inputExchangeAddress } = useTokenDetails(
    inputCurrency
  )
  const { symbol: outputSymbol, decimals: outputDecimals, exchangeAddress: outputExchangeAddress } = useTokenDetails(
    outputCurrency
  )

  const inputExchangeContract = useExchangeContract(inputExchangeAddress)
  const outputExchangeContract = useExchangeContract(outputExchangeAddress)
  const contract = swapType === ETH_TO_TOKEN ? outputExchangeContract : inputExchangeContract

  // get input allowance
  const inputAllowance = useAddressAllowance(account, inputCurrency, ZERO_EX_ASSET_PROXY_ADDRESSES.ERC20);

  // fetch reserves for each of the currency types
  const { reserveETH: inputReserveETH, reserveToken: inputReserveToken } = useExchangeReserves(inputCurrency)
  const { reserveETH: outputReserveETH, reserveToken: outputReserveToken } = useExchangeReserves(outputCurrency)

  // get balances for each of the currency types
  const inputBalance = useAddressBalance(account, inputCurrency)
  const outputBalance = useAddressBalance(account, outputCurrency)
  const inputBalanceFormatted = !!(inputBalance && Number.isInteger(inputDecimals))
    ? amountFormatter(inputBalance, inputDecimals, Math.min(4, inputDecimals))
    : ''
  const outputBalanceFormatted = !!(outputBalance && Number.isInteger(outputDecimals))
    ? amountFormatter(outputBalance, outputDecimals, Math.min(4, outputDecimals))
    : ''

  // compute useful transforms of the data above
  const independentDecimals = independentField === INPUT ? inputDecimals : outputDecimals
  const dependentDecimals = independentField === OUTPUT ? inputDecimals : outputDecimals

  // declare/get parsed and formatted versions of input/output values
  const [independentValueParsed, setIndependentValueParsed] = useState()
  const dependentValueFormatted = !!(dependentValue && (dependentDecimals || dependentDecimals === 0))
    ? amountFormatter(dependentValue, dependentDecimals, Math.min(4, dependentDecimals), false)
    : ''
  const inputValueParsed = independentField === INPUT ? independentValueParsed : dependentValue
  const inputValueFormatted = independentField === INPUT ? independentValue : dependentValueFormatted
  const outputValueParsed = independentField === OUTPUT ? independentValueParsed : dependentValue
  const outputValueFormatted = independentField === OUTPUT ? independentValue : dependentValueFormatted

  // validate + parse independent value
  const [independentError, setIndependentError] = useState()
  useEffect(() => {
    if (independentValue && (independentDecimals || independentDecimals === 0)) {
      try {
        const parsedValue = ethers.utils.parseUnits(independentValue, independentDecimals)

        if (parsedValue.lte(ethers.constants.Zero) || parsedValue.gte(ethers.constants.MaxUint256)) {
          throw Error()
        } else {
          setIndependentValueParsed(parsedValue)
          setIndependentError(null)
        }
      } catch {
        setIndependentError(t('inputNotValid'))
      }

      return () => {
        setIndependentValueParsed()
        setIndependentError()
      }
    }
  }, [independentValue, independentDecimals, t])

  // calculate slippage from target rate
  const { minimum: dependentValueMinumum, maximum: dependentValueMaximum } = calculateSlippageBounds(
    dependentValue,
    swapType === TOKEN_TO_TOKEN,
    tokenAllowedSlippageBig,
    allowedSlippageBig
  )

  // validate input allowance + balance
  const [inputError, setInputError] = useState()
  const [showUnlock, setShowUnlock] = useState(false)
  useEffect(() => {
    const inputValueCalculation = independentField === INPUT ? independentValueParsed : dependentValueMaximum
    if (inputBalance && (inputAllowance || inputCurrency === 'ETH') && inputValueCalculation) {
      if (inputBalance.lt(inputValueCalculation)) {
        setInputError(t('insufficientBalance'))
      } else if (inputCurrency !== 'ETH' && inputAllowance.lt(inputValueCalculation)) {
        setInputError(t('unlockTokenCont'))
        setShowUnlock(true)
      } else {
        setInputError(null)
        setShowUnlock(false)
      }
      return () => {
        setInputError()
        setShowUnlock(false)
      }
    }
  }, [independentField, independentValueParsed, dependentValueMaximum, inputBalance, inputCurrency, inputAllowance, t])

  // calculate dependent value
  useEffect(() => {
    const amount = independentValueParsed

    if (!!amount && inputCurrency !== '' && outputCurrency !== '') {
      (async ()=> {
        const quote = await fetchZeroExAPIQuoteAsync(inputCurrency, outputCurrency, amount, independentField === OUTPUT);
        dispatchSwapState({
          type: 'UPDATE_DEPENDENT',
          payload: ethers.utils.bigNumberify(independentField === INPUT ? quote.buyAmount : quote.sellAmount),
        })
      })();
    }
  }, [
    independentValueParsed,
    swapType,
    outputReserveETH,
    outputReserveToken,
    inputReserveETH,
    inputReserveToken,
    independentField,
    t,
    inputCurrency,
    outputCurrency,
  ])

  useEffect(() => {
    const history = createBrowserHistory()
    history.push(window.location.pathname + '')
  }, [])

  const [inverted, setInverted] = useState(false)
  const exchangeRate = getExchangeRate(inputValueParsed, inputDecimals, outputValueParsed, outputDecimals)
  const exchangeRateInverted = getExchangeRate(inputValueParsed, inputDecimals, outputValueParsed, outputDecimals, true)

  const marketRate = getMarketRate(
    swapType,
    inputReserveETH,
    inputReserveToken,
    inputDecimals,
    outputReserveETH,
    outputReserveToken,
    outputDecimals
  )

  const percentSlippage =
    exchangeRate && marketRate
      ? exchangeRate
          .sub(marketRate)
          .abs()
          .mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(18)))
          .div(marketRate)
          .sub(ethers.utils.bigNumberify(3).mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(15))))
      : undefined
  const percentSlippageFormatted = percentSlippage && amountFormatter(percentSlippage, 16, 2)
  const slippageWarning =
    percentSlippage &&
    percentSlippage.gte(ethers.utils.parseEther('.05')) &&
    percentSlippage.lt(ethers.utils.parseEther('.2')) // [5% - 20%)
  const highSlippageWarning = percentSlippage && percentSlippage.gte(ethers.utils.parseEther('.2')) // [20+%

  const isValid = sending
    ? exchangeRate && inputError === null && independentError === null && recipientError === null && deadlineFromNow
    : exchangeRate && inputError === null && independentError === null && deadlineFromNow

  const estimatedText = `(${t('estimated')})`
  function formatBalance(value) {
    return `Balance: ${value}`
  }

  async function onSwap() {
    //if user changed deadline, log new one in minutes
    if (deadlineFromNow !== DEFAULT_DEADLINE_FROM_NOW) {
      ReactGA.event({
        category: 'Advanced Interaction',
        action: 'Set Custom Deadline',
        value: deadlineFromNow / 60
      })
    }

    const deadline = Math.ceil(Date.now() / 1000) + deadlineFromNow

    // if user has changed slippage, log
    if (swapType === TOKEN_TO_TOKEN) {
      if (parseInt(tokenAllowedSlippageBig.toString()) !== TOKEN_ALLOWED_SLIPPAGE_DEFAULT) {
        ReactGA.event({
          category: 'Advanced Interaction',
          action: 'Set Custom Slippage',
          value: parseInt(tokenAllowedSlippageBig.toString())
        })
      }
    } else {
      if (parseInt(allowedSlippageBig.toString()) !== ALLOWED_SLIPPAGE_DEFAULT) {
        ReactGA.event({
          category: 'Advanced Interaction',
          action: 'Set Custom Slippage',
          value: parseInt(allowedSlippageBig.toString())
        })
      }
    }

    let estimate, method, args, value

    let inputEthPerToken = 1
    if (inputCurrency !== 'ETH') {
      inputEthPerToken = inputReserveToken && inputReserveETH ? inputReserveETH / inputReserveToken : null
    }
    let usdTransactionSize = ethPrice * inputEthPerToken * inputValueFormatted

    if (independentField === INPUT) {
      // general details about transaction
      ReactGA.event({
        category: 'Transaction',
        action: sending ? 'SendInput' : 'SwapInput',
        label: outputCurrency,
        value: usdTransactionSize
      })

      if (swapType === ETH_TO_TOKEN) {
        estimate = sending ? contract.estimate.ethToTokenTransferInput : contract.estimate.ethToTokenSwapInput
        method = sending ? contract.ethToTokenTransferInput : contract.ethToTokenSwapInput
        args = sending ? [dependentValueMinumum, deadline, recipient.address] : [dependentValueMinumum, deadline]
        value = independentValueParsed
      } else if (swapType === TOKEN_TO_TOKEN) {
        estimate = sending ? contract.estimate.tokenToTokenTransferInput : contract.estimate.tokenToTokenSwapInput
        method = sending ? contract.tokenToTokenTransferInput : contract.tokenToTokenSwapInput
        args = sending
          ? [
              independentValueParsed,
              dependentValueMinumum,
              ethers.constants.One,
              deadline,
              recipient.address,
              outputCurrency
            ]
          : [independentValueParsed, dependentValueMinumum, ethers.constants.One, deadline, outputCurrency]
        value = ethers.constants.Zero
      }
    } else if (independentField === OUTPUT) {
      // general details about transaction
      ReactGA.event({
        category: 'Transaction',
        action: sending ? 'SendOutput' : 'SwapOutput',
        label: outputCurrency,
        value: usdTransactionSize
      })

      if (swapType === ETH_TO_TOKEN) {
        estimate = sending ? contract.estimate.ethToTokenTransferOutput : contract.estimate.ethToTokenSwapOutput
        method = sending ? contract.ethToTokenTransferOutput : contract.ethToTokenSwapOutput
        args = sending ? [independentValueParsed, deadline, recipient.address] : [independentValueParsed, deadline]
        value = dependentValueMaximum
      } else if (swapType === TOKEN_TO_TOKEN) {
        estimate = sending ? contract.estimate.tokenToTokenTransferOutput : contract.estimate.tokenToTokenSwapOutput
        method = sending ? contract.tokenToTokenTransferOutput : contract.tokenToTokenSwapOutput
        args = sending
          ? [
              independentValueParsed,
              dependentValueMaximum,
              ethers.constants.MaxUint256,
              deadline,
              recipient.address,
              outputCurrency
            ]
          : [independentValueParsed, dependentValueMaximum, ethers.constants.MaxUint256, deadline, outputCurrency]
        value = ethers.constants.Zero
      }
    }

    fetchZeroExAPIQuoteAsync(inputCurrency, outputCurrency, independentValueParsed, independentField === OUTPUT, account)
    .then(quote => {
      return signerInstance.sendTransaction({
        to: quote.to,
        gasLimit: ethers.utils.bigNumberify(quote.gas),
        gasPrice: ethers.utils.bigNumberify(quote.gasPrice),
        data: quote.data,
        value: ethers.utils.bigNumberify(quote.value),
      });
    })
    .then(response => {
      addTransaction(response)
    })
  }

  const [customSlippageError, setcustomSlippageError] = useState('')

  const toggleWalletModal = useWalletModalToggle()

  return (
    <>
      <CurrencyInputPanel
        title={t('input')}
        description={inputValueFormatted && independentField === OUTPUT ? estimatedText : ''}
        extraText={inputBalanceFormatted && formatBalance(inputBalanceFormatted)}
        extraTextClickHander={() => {
          if (inputBalance && inputDecimals) {
            const valueToSet = inputCurrency === 'ETH' ? inputBalance.sub(ethers.utils.parseEther('.1')) : inputBalance
            if (valueToSet.gt(ethers.constants.Zero)) {
              dispatchSwapState({
                type: 'UPDATE_INDEPENDENT',
                payload: {
                  value: amountFormatter(valueToSet, inputDecimals, inputDecimals, false),
                  field: INPUT
                }
              })
            }
          }
        }}
        onCurrencySelected={inputCurrency => {
          dispatchSwapState({
            type: 'SELECT_CURRENCY',
            payload: { currency: inputCurrency, field: INPUT }
          })
        }}
        onValueChange={inputValue => {
          dispatchSwapState({
            type: 'UPDATE_INDEPENDENT',
            payload: { value: inputValue, field: INPUT }
          })
        }}
        showUnlock={showUnlock}
        selectedTokens={[inputCurrency, outputCurrency]}
        selectedTokenAddress={inputCurrency}
        value={inputValueFormatted}
        errorMessage={inputError ? inputError : independentField === INPUT ? independentError : ''}
      />
      <OversizedPanel>
        <DownArrowBackground>
          <DownArrow
            onClick={() => {
              dispatchSwapState({ type: 'FLIP_INDEPENDENT' })
            }}
            clickable
            alt="swap"
            active={isValid}
          />
        </DownArrowBackground>
      </OversizedPanel>
      <CurrencyInputPanel
        title={t('output')}
        description={outputValueFormatted && independentField === INPUT ? estimatedText : ''}
        extraText={outputBalanceFormatted && formatBalance(outputBalanceFormatted)}
        onCurrencySelected={outputCurrency => {
          dispatchSwapState({
            type: 'SELECT_CURRENCY',
            payload: { currency: outputCurrency, field: OUTPUT }
          })
        }}
        onValueChange={outputValue => {
          dispatchSwapState({
            type: 'UPDATE_INDEPENDENT',
            payload: { value: outputValue, field: OUTPUT }
          })
        }}
        selectedTokens={[inputCurrency, outputCurrency]}
        selectedTokenAddress={outputCurrency}
        value={outputValueFormatted}
        errorMessage={independentField === OUTPUT ? independentError : ''}
        disableUnlock
        filteredOutTokens={['ETH']}
      />
      {sending ? (
        <>
          <OversizedPanel>
            <DownArrowBackground>
              <DownArrow active={isValid} alt="arrow" />
            </DownArrowBackground>
          </OversizedPanel>
          <AddressInputPanel onChange={setRecipient} onError={setRecipientError} initialInput={recipient} />
        </>
      ) : (
        ''
      )}
      <OversizedPanel hideBottom>
        <ExchangeRateWrapper
          onClick={() => {
            setInverted(inverted => !inverted)
          }}
        >
          <ExchangeRate>{t('exchangeRate')}</ExchangeRate>
          {inverted ? (
            <span>
              {exchangeRate
                ? `1 ${inputSymbol} = ${amountFormatter(exchangeRate, 18, 6, false)} ${outputSymbol}`
                : ' - '}
            </span>
          ) : (
            <span>
              {exchangeRate
                ? `1 ${outputSymbol} = ${amountFormatter(exchangeRateInverted, 18, 6, false)} ${inputSymbol}`
                : ' - '}
            </span>
          )}
        </ExchangeRateWrapper>
      </OversizedPanel>
      <TransactionDetails
        account={account}
        setRawSlippage={setRawSlippage}
        setRawTokenSlippage={setRawTokenSlippage}
        rawSlippage={rawSlippage}
        slippageWarning={slippageWarning}
        highSlippageWarning={highSlippageWarning}
        setDeadline={setDeadlineFromNow}
        deadline={deadlineFromNow}
        inputError={inputError}
        independentError={independentError}
        inputCurrency={inputCurrency}
        outputCurrency={outputCurrency}
        independentValue={independentValue}
        independentValueParsed={independentValueParsed}
        independentField={independentField}
        INPUT={INPUT}
        inputValueParsed={inputValueParsed}
        outputValueParsed={outputValueParsed}
        inputSymbol={inputSymbol}
        outputSymbol={outputSymbol}
        dependentValueMinumum={dependentValueMinumum}
        dependentValueMaximum={dependentValueMaximum}
        dependentDecimals={dependentDecimals}
        independentDecimals={independentDecimals}
        percentSlippageFormatted={percentSlippageFormatted}
        setcustomSlippageError={setcustomSlippageError}
        recipientAddress={recipient.address}
        sending={sending}
      />
      <Flex>
        <Button
          disabled={!account && !error ? false : !isValid || customSlippageError === 'invalid'}
          onClick={account && !error ? onSwap : toggleWalletModal}
          warning={highSlippageWarning || customSlippageError === 'warning'}
          loggedOut={!account}
        >
          {!account
            ? 'Connect to a Wallet'
            : sending
            ? highSlippageWarning || customSlippageError === 'warning'
              ? t('sendAnyway')
              : t('send')
            : highSlippageWarning || customSlippageError === 'warning'
            ? t('swapAnyway')
            : t('swap')}
        </Button>
      </Flex>
    </>
  )
}
