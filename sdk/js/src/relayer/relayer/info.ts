import {
  ChainId,
  CHAIN_ID_TO_NAME,
  ChainName,
  isChain,
  CONTRACTS,
  CHAINS,
  tryNativeToHexString,
  Network,
  ethers_contracts,
  parseTransferPayload,
} from "../..";
import { BigNumber, ethers } from "ethers";
import { getWormholeRelayerAddress } from "../consts";
import {
  RelayerPayloadId,
  DeliveryInstruction,
  RefundStatus,
  parseEVMExecutionInfoV1,
  DeliveryOverrideArgs,
  KeyType,
  parseVaaKey,
  parseCCTPKey,
  RedeliveryInstruction,
} from "../structs";
import {
  getDefaultProvider,
  printChain,
  printCCTPDomain,
  getWormholeLog,
  parseWormholeLog,
  getDeliveryHashFromLog,
  getRelayerTransactionHashFromWormscan,
  getWormholeRelayerInfoByHash,
  getWormscanRelayerInfo,
  getWormscanInfo,
  CCTP_DOMAIN_TO_NAME,
  estimatedAttestationTimeInSeconds,
} from "./helpers";
import {
  AdditionalMessageParsed,
  CCTPTransferParsed,
  DeliveryInfo,
  TokenTransferParsed,
} from "./deliver";
import { ERC20__factory } from "../../ethers-contracts";

export type InfoRequestParams = {
  environment?: Network;
  sourceChainProvider?: ethers.providers.Provider;
  targetChainProviders?: Map<ChainName, ethers.providers.Provider>;
  wormholeRelayerWhMessageIndex?: number;
  wormholeRelayerAddresses?: Map<ChainName, string>;
};

export type GetPriceOptParams = {
  environment?: Network;
  receiverValue?: ethers.BigNumberish;
  wormholeRelayerAddress?: string;
  deliveryProviderAddress?: string;
  sourceChainProvider?: ethers.providers.Provider;
};

export async function getPriceAndRefundInfo(
  sourceChain: ChainName,
  targetChain: ChainName,
  gasAmount: ethers.BigNumberish,
  optionalParams?: GetPriceOptParams
): Promise<[ethers.BigNumber, ethers.BigNumber]> {
  const environment = optionalParams?.environment || "MAINNET";
  const sourceChainProvider =
    optionalParams?.sourceChainProvider ||
    getDefaultProvider(environment, sourceChain);
  if (!sourceChainProvider)
    throw Error(
      "No default RPC for this chain; pass in your own provider (as sourceChainProvider)"
    );
  const wormholeRelayerAddress =
    optionalParams?.wormholeRelayerAddress ||
    getWormholeRelayerAddress(sourceChain, environment);
  const sourceWormholeRelayer =
    ethers_contracts.IWormholeRelayer__factory.connect(
      wormholeRelayerAddress,
      sourceChainProvider
    );
  const deliveryProviderAddress =
    optionalParams?.deliveryProviderAddress ||
    (await sourceWormholeRelayer.getDefaultDeliveryProvider());
  const targetChainId = CHAINS[targetChain];
  const priceAndRefundInfo = await sourceWormholeRelayer[
    "quoteEVMDeliveryPrice(uint16,uint256,uint256,address)"
  ](
    targetChainId,
    optionalParams?.receiverValue || 0,
    gasAmount,
    deliveryProviderAddress
  );
  return priceAndRefundInfo;
}

export async function getPrice(
  sourceChain: ChainName,
  targetChain: ChainName,
  gasAmount: ethers.BigNumberish,
  optionalParams?: GetPriceOptParams
): Promise<ethers.BigNumber> {
  const priceAndRefundInfo = await getPriceAndRefundInfo(
    sourceChain,
    targetChain,
    gasAmount,
    optionalParams
  );
  return priceAndRefundInfo[0];
}

export async function getWormholeRelayerInfo(
  sourceChain: ChainName,
  sourceTransaction: string,
  infoRequest?: InfoRequestParams
): Promise<DeliveryInfo> {
  const environment = infoRequest?.environment || "MAINNET";
  const sourceChainProvider =
    infoRequest?.sourceChainProvider ||
    getDefaultProvider(environment, sourceChain);
  if (!sourceChainProvider)
    throw Error(
      "No default RPC for this chain; pass in your own provider (as sourceChainProvider)"
    );
  const receipt = await sourceChainProvider.getTransactionReceipt(
    sourceTransaction
  );
  if (!receipt) throw Error("Transaction has not been mined");
  const sourceTimestamp =
    (await sourceChainProvider.getBlock(receipt.blockNumber)).timestamp * 1000;
  const bridgeAddress = CONTRACTS[environment][sourceChain].core;
  const wormholeRelayerAddress =
    infoRequest?.wormholeRelayerAddresses?.get(sourceChain) ||
    getWormholeRelayerAddress(sourceChain, environment);
  if (!bridgeAddress || !wormholeRelayerAddress) {
    throw Error(
      `Invalid chain ID or network: Chain ${sourceChain}, ${environment}`
    );
  }
  const deliveryLog = getWormholeLog(
    receipt,
    bridgeAddress,
    tryNativeToHexString(wormholeRelayerAddress, "ethereum"),
    infoRequest?.wormholeRelayerWhMessageIndex
      ? infoRequest.wormholeRelayerWhMessageIndex
      : 0
  );

  const { type, parsed } = parseWormholeLog(deliveryLog.log);

  if (type === RelayerPayloadId.Redelivery) {
    const redeliveryInstruction = parsed as RedeliveryInstruction;

    if (!isChain(redeliveryInstruction.deliveryVaaKey.chainId)) {
      throw new Error(
        `The chain ID specified by this redelivery is invalid: ${redeliveryInstruction.deliveryVaaKey.chainId}`
      );
    }
    if (!isChain(redeliveryInstruction.targetChainId)) {
      throw new Error(
        `The target chain ID specified by this redelivery is invalid: ${redeliveryInstruction.targetChainId}`
      );
    }

    const originalSourceChainName =
      CHAIN_ID_TO_NAME[redeliveryInstruction.deliveryVaaKey.chainId as ChainId];

    const modifiedInfoRequest = infoRequest;
    if (modifiedInfoRequest?.sourceChainProvider) {
      modifiedInfoRequest.sourceChainProvider =
        modifiedInfoRequest?.targetChainProviders?.get(originalSourceChainName);
    }

    const transactionHash = await getRelayerTransactionHashFromWormscan(
      originalSourceChainName,
      redeliveryInstruction.deliveryVaaKey.sequence.toNumber(),
      {
        network: infoRequest?.environment,
        provider: infoRequest?.targetChainProviders?.get(
          originalSourceChainName
        ),
        wormholeRelayerAddress: infoRequest?.wormholeRelayerAddresses?.get(
          originalSourceChainName
        ),
      }
    );

    return getWormholeRelayerInfo(
      originalSourceChainName,
      transactionHash,
      modifiedInfoRequest
    );
  }

  const instruction = parsed as DeliveryInstruction;

  const targetChainId = instruction.targetChainId;

  if (!isChain(targetChainId)) throw Error(`Invalid Chain: ${targetChainId}`);
  const targetChain = CHAIN_ID_TO_NAME[targetChainId];
  const targetChainProvider =
    infoRequest?.targetChainProviders?.get(targetChain) ||
    getDefaultProvider(environment, targetChain);

  if (!targetChainProvider) {
    throw Error(
      "No default RPC for this chain; pass in your own provider (as targetChainProvider)"
    );
  }

  const sourceSequence = BigNumber.from(deliveryLog.sequence);

  const deliveryHash = await getDeliveryHashFromLog(
    deliveryLog.log,
    CHAINS[sourceChain],
    sourceChainProvider,
    receipt.blockHash
  );

  const vaa = await getWormscanRelayerInfo(
    sourceChain,
    sourceSequence.toNumber(),
    {
      network: infoRequest?.environment,
      provider: infoRequest?.sourceChainProvider,
      wormholeRelayerAddress:
        infoRequest?.wormholeRelayerAddresses?.get(sourceChain),
    }
  );
  const signingOfVaaTimestamp = new Date(
    (await vaa.json()).data?.indexedAt
  ).getTime();

  // obtain additional message info
  const additionalMessageInformation: AdditionalMessageParsed[] =
    await Promise.all(
      instruction.messageKeys.map(async (messageKey) => {
        if (messageKey.keyType === 1) {
          // check receipt
          const vaaKey = parseVaaKey(messageKey.key);

          // if token bridge transfer in logs, parse it
          let tokenBridgeLog;
          const tokenBridgeEmitterAddress = tryNativeToHexString(
            CONTRACTS[environment][sourceChain].token_bridge || "",
            sourceChain
          );
          try {
            if (
              vaaKey.chainId === CHAINS[sourceChain] &&
              vaaKey.emitterAddress.toString("hex") ===
                tokenBridgeEmitterAddress
            ) {
              tokenBridgeLog = getWormholeLog(
                receipt,
                CONTRACTS[environment][sourceChain].core || "",
                tokenBridgeEmitterAddress,
                0,
                vaaKey.sequence.toNumber()
              );
            }
          } catch (e) {
            console.log(e);
          }
          if (!tokenBridgeLog) return undefined;
          const parsedTokenInfo = parseTransferPayload(
            Buffer.from(tokenBridgeLog.payload.substring(2), "hex")
          );
          const originChainName =
            CHAIN_ID_TO_NAME[parsedTokenInfo.originChain as ChainId];
          let signedVaaTimestamp = undefined;
          let tokenName = undefined;
          let tokenSymbol = undefined;
          let tokenDecimals = undefined;

          // Try to get additional token information, assuming it is an ERC20
          try {
            const tokenProvider =
              (parsedTokenInfo.originChain === CHAINS[sourceChain]
                ? infoRequest?.sourceChainProvider
                : infoRequest?.targetChainProviders?.get(originChainName)) ||
              getDefaultProvider(environment, originChainName);
            const tokenContract = ERC20__factory.connect(
              "0x" + parsedTokenInfo.originAddress.substring(24),
              tokenProvider
            );
            tokenName = await tokenContract.name();
            tokenSymbol = await tokenContract.symbol();
            tokenDecimals = await tokenContract.decimals();
          } catch (e) {
            console.log(e);
          }
          // Try to get wormscan information on if the tokens have been signed
          try {
            const tokenVaa = await getWormscanInfo(
              environment,
              sourceChain,
              parseInt(tokenBridgeLog.sequence),
              CONTRACTS[environment][sourceChain].token_bridge || ""
            );
            signedVaaTimestamp = new Date(
              (await tokenVaa.json()).data?.indexedAt
            ).getTime();
          } catch {}

          const parsed: TokenTransferParsed = {
            amount: BigNumber.from(parsedTokenInfo.amount)
              .mul(
                BigNumber.from(10).pow(
                  tokenDecimals && tokenDecimals > 8 ? tokenDecimals - 8 : 1
                )
              )
              .toBigInt(),
            originAddress: parsedTokenInfo.originAddress,
            originChain: parsedTokenInfo.originChain,
            targetAddress: parsedTokenInfo.targetAddress,
            targetChain: parsedTokenInfo.targetChain,
            fromAddress: parsedTokenInfo.fromAddress,
            name: tokenName,
            symbol: tokenSymbol,
            decimals: tokenDecimals,
            signedVaaTimestamp,
          };
          return parsed;
        } else if (messageKey.keyType === 2) {
          // check receipt
          const cctpKey = parseCCTPKey(messageKey.key);

          let cctpLog;
          let messageSentLog;
          const DepositForBurnTopic =
            "0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0";
          const MessageSentTopic =
            "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036";
          try {
            if (CCTP_DOMAIN_TO_NAME[cctpKey.domain] === sourceChain) {
              const cctpLogFilter = (log: ethers.providers.Log) => {
                return (
                  log.topics[0] === DepositForBurnTopic &&
                  parseInt(log.topics[1]) === cctpKey.nonce.toNumber()
                );
              };
              cctpLog = receipt.logs.find(cctpLogFilter);
              const index = receipt.logs.findIndex(cctpLogFilter);
              const messageSentLogs = receipt.logs.filter((log, i) => {
                return log.topics[0] === MessageSentTopic && i <= index;
              });
              messageSentLog = messageSentLogs[messageSentLogs.length - 1];
            }
          } catch (e) {
            console.log(e);
          }
          if (!cctpLog || !messageSentLog) return undefined;

          // Try to get attestation information on if the tokens have been signed
          let attested = false;
          try {
            const message = new ethers.utils.Interface([
              "event MessageSent(bytes message)",
            ]).parseLog(messageSentLog).args.message;
            const msgHash = ethers.utils.keccak256(message);
            const url =
              (environment === "TESTNET"
                ? "https://iris-api-sandbox.circle.com/v1/attestations/"
                : "https://iris-api.circle.com/v1/attestations/") + msgHash;
            const attestation = await fetch(url);
            attested = (await attestation.json()).status === "complete";
          } catch (e) {
            console.log(e);
          }

          const parsed: CCTPTransferParsed = {
            amount: BigNumber.from(
              Buffer.from(cctpLog.data.substring(2, 2 + 64), "hex")
            ).toBigInt(),
            mintRecipient: "0x" + cctpLog.data.substring(2 + 64 + 24, 2 + 128),
            destinationDomain: BigNumber.from(
              Buffer.from(cctpLog.data.substring(2 + 128, 2 + 192), "hex")
            ).toNumber(),
            attested,
            estimatedAttestationSeconds: estimatedAttestationTimeInSeconds(
              sourceChain,
              environment
            ),
          };
          return parsed;
        } else {
          return undefined;
        }
      })
    );

  const targetChainDeliveries = await getWormholeRelayerInfoByHash(
    deliveryHash,
    targetChain,
    sourceChain,
    sourceSequence.toNumber(),
    infoRequest
  );

  const result: DeliveryInfo = {
    type: RelayerPayloadId.Delivery,
    sourceChain: sourceChain,
    sourceTransactionHash: sourceTransaction,
    sourceDeliverySequenceNumber: sourceSequence.toNumber(),
    deliveryInstruction: instruction,
    sourceTimestamp,
    signingOfVaaTimestamp,
    additionalMessageInformation,
    targetChainStatus: {
      chain: targetChain,
      events: targetChainDeliveries,
    },
  };
  const stringified = stringifyWormholeRelayerInfo(result);
  result.stringified = stringified;
  return result;
}

export function printWormholeRelayerInfo(info: DeliveryInfo) {
  console.log(stringifyWormholeRelayerInfo(info));
}

export function stringifyWormholeRelayerInfo(
  info: DeliveryInfo,
  excludeSourceInformation?: boolean,
  overrides?: DeliveryOverrideArgs
): string {
  let stringifiedInfo = "";
  if (
    info.type == RelayerPayloadId.Delivery &&
    info.deliveryInstruction.targetAddress.toString("hex") !==
      "0000000000000000000000000000000000000000000000000000000000000000"
  ) {
    if (!excludeSourceInformation) {
      stringifiedInfo += `Source chain: ${info.sourceChain}\n`;

      stringifiedInfo += `Source Transaction Hash: ${info.sourceTransactionHash}\n`;
      stringifiedInfo += `Sender: ${
        "0x" +
        info.deliveryInstruction.senderAddress.toString("hex").substring(24)
      }\n`;
      stringifiedInfo += `Delivery sequence number: ${info.sourceDeliverySequenceNumber}\n`;
    } else {
      stringifiedInfo += `Sender: ${info.deliveryInstruction.senderAddress.toString(
        "hex"
      )}\n`;
    }
    const numMsgs = info.deliveryInstruction.messageKeys.length;

    const payload = info.deliveryInstruction.payload.toString("hex");
    if (payload.length > 0) {
      stringifiedInfo += `\nPayload to be relayed: 0x${payload}\n`;
    }
    if (numMsgs > 0) {
      stringifiedInfo += `\nThe following ${
        numMsgs === 1 ? "" : `${numMsgs} `
      }message${numMsgs === 1 ? " was" : "s were"} ${
        payload.length > 0 ? "also " : ""
      }requested to be relayed with this delivery:\n`;
      stringifiedInfo += info.deliveryInstruction.messageKeys
        .map((msgKey, i) => {
          let result = "";
          if (msgKey.keyType == KeyType.VAA) {
            const vaaKey = parseVaaKey(msgKey.key);
            result += `(Message ${i + 1}): `;
            result += `Wormhole VAA from ${
              vaaKey.chainId ? printChain(vaaKey.chainId) : ""
            }, with emitter address ${vaaKey.emitterAddress?.toString(
              "hex"
            )} and sequence number ${vaaKey.sequence}`;
            if (info.additionalMessageInformation[i]) {
              const tokenTransferInfo = info.additionalMessageInformation[
                i
              ] as TokenTransferParsed;
              result += `\nThis is a token bridge transfer of ${
                tokenTransferInfo.decimals
                  ? `${ethers.utils.formatUnits(
                      tokenTransferInfo.amount,
                      tokenTransferInfo.decimals
                    )} `
                  : `${tokenTransferInfo.amount} normalized units of `
              }${
                tokenTransferInfo.name
                  ? `${tokenTransferInfo.name} (${tokenTransferInfo.symbol})`
                  : `token ${tokenTransferInfo.originAddress.substring(
                      24
                    )} (which is native to ${printChain(
                      tokenTransferInfo.originChain
                    )})`
              }`;
              if (tokenTransferInfo.signedVaaTimestamp) {
                result += `\ntransfer signed by guardians: ${new Date(
                  tokenTransferInfo.signedVaaTimestamp
                ).toString()}`;
              } else {
                result += `\ntransfer not yet signed by guardians`;
              }
            }
          } else if (msgKey.keyType == KeyType.CCTP) {
            const cctpKey = parseCCTPKey(msgKey.key);
            result += `(Message ${i + 1}): `;
            result += `CCTP Transfer from domain ${printCCTPDomain(
              cctpKey.domain
            )}`;
            result += `, with nonce ${cctpKey.nonce}`;
            if (info.additionalMessageInformation[i]) {
              const cctpTransferInfo = info.additionalMessageInformation[
                i
              ] as CCTPTransferParsed;
              result += `\nThis is a CCTP transfer of ${`${ethers.utils.formatUnits(
                cctpTransferInfo.amount,
                6
              )}`} USDC ${
                cctpTransferInfo.attested
                  ? "(Attestation is complete"
                  : "(Attestation currently pending"
              }, typically takes ${
                cctpTransferInfo.estimatedAttestationSeconds < 60
                  ? `${cctpTransferInfo.estimatedAttestationSeconds} seconds`
                  : `${
                      cctpTransferInfo.estimatedAttestationSeconds / 60
                    } minutes`
              })`;
            }
          } else {
            result += `(Unknown key type ${i}): ${msgKey.keyType}`;
          }
          return result;
        })
        .join(",\n");
    }
    if (payload.length == 0 && numMsgs == 0) {
      stringifiedInfo += `\nAn empty payload was requested to be sent`;
    }

    const instruction = info.deliveryInstruction;
    if (overrides) {
      instruction.requestedReceiverValue = overrides.newReceiverValue;
      instruction.encodedExecutionInfo = overrides.newExecutionInfo;
    }

    const targetChainName =
      CHAIN_ID_TO_NAME[instruction.targetChainId as ChainId];
    stringifiedInfo += `\n\nDestination chain: ${printChain(
      instruction.targetChainId
    )}\nDestination address: 0x${instruction.targetAddress
      .toString("hex")
      .substring(24)}\n\n`;
    const totalReceiverValue = instruction.requestedReceiverValue.add(
      instruction.extraReceiverValue
    );
    stringifiedInfo += totalReceiverValue.gt(0)
      ? `Amount to pass into target address: ${ethers.utils.formatEther(
          totalReceiverValue
        )} of ${targetChainName} currency ${
          instruction.extraReceiverValue.gt(0)
            ? `\n${ethers.utils.formatEther(
                instruction.requestedReceiverValue
              )} requested, ${ethers.utils.formatEther(
                instruction.extraReceiverValue
              )} additionally paid for`
            : ""
        }\n`
      : ``;
    const [executionInfo] = parseEVMExecutionInfoV1(
      instruction.encodedExecutionInfo,
      0
    );
    stringifiedInfo += `Gas limit: ${executionInfo.gasLimit} ${targetChainName} gas\n`;

    const refundAddressChosen =
      instruction.refundAddress.toString("hex") !==
      "0000000000000000000000000000000000000000000000000000000000000000";
    if (refundAddressChosen) {
      stringifiedInfo += `Refund rate: ${ethers.utils.formatEther(
        executionInfo.targetChainRefundPerGasUnused
      )} of ${targetChainName} currency per unit of gas unused\n`;
      stringifiedInfo += `Refund address: ${instruction.refundAddress.toString(
        "hex"
      )} on ${printChain(instruction.refundChainId)}\n`;
    }
    stringifiedInfo += `\n`;
    if (info.sourceTimestamp) {
      stringifiedInfo += `Sent: ${new Date(info.sourceTimestamp).toString()}\n`;
    }
    if (info.signingOfVaaTimestamp) {
      stringifiedInfo += `Delivery vaa signed by guardians: ${new Date(
        info.signingOfVaaTimestamp
      ).toString()}\n`;
    } else {
      stringifiedInfo += `Delivery not yet signed by guardians - check https://wormhole-foundation.github.io/wormhole-dashboard/#/ for status\n`;
    }
    stringifiedInfo += `\n`;
    if (info.targetChainStatus.events.length === 0) {
      stringifiedInfo += "Delivery has not occured yet\n";
    }
    stringifiedInfo += info.targetChainStatus.events

      .map(
        (e, i) =>
          `Delivery attempt: ${
            e.transactionHash
              ? ` ${targetChainName} transaction hash: ${e.transactionHash}`
              : ""
          }\nDelivery Time: ${new Date(
            e.timestamp as number
          ).toString()}\nStatus: ${e.status}\n${
            e.revertString
              ? `Failure reason: ${
                  e.gasUsed.eq(executionInfo.gasLimit)
                    ? "Gas limit hit"
                    : e.revertString
                }\n`
              : ""
          }Gas used: ${e.gasUsed.toString()}\nTransaction fee used: ${ethers.utils.formatEther(
            executionInfo.targetChainRefundPerGasUnused.mul(e.gasUsed)
          )} of ${targetChainName} currency\n${`Refund amount: ${ethers.utils.formatEther(
            executionInfo.targetChainRefundPerGasUnused.mul(
              executionInfo.gasLimit.sub(e.gasUsed)
            )
          )} of ${targetChainName} currency \nRefund status: ${
            e.refundStatus
          }\n`}`
      )
      .join("\n");
  } else if (
    info.type == RelayerPayloadId.Delivery &&
    info.deliveryInstruction.targetAddress.toString("hex") ===
      "0000000000000000000000000000000000000000000000000000000000000000"
  ) {
    stringifiedInfo += `Found delivery request in transaction ${info.sourceTransactionHash} on ${info.sourceChain}\n`;

    const instruction = info.deliveryInstruction;
    const targetChainName =
      CHAIN_ID_TO_NAME[instruction.targetChainId as ChainId];

    stringifiedInfo += `\nA refund of ${ethers.utils.formatEther(
      instruction.extraReceiverValue
    )} ${targetChainName} currency was requested to be sent to ${targetChainName}, address 0x${info.deliveryInstruction.refundAddress.toString(
      "hex"
    )}\n\n`;

    stringifiedInfo += info.targetChainStatus.events

      .map(
        (e, i) =>
          `Delivery attempt: ${
            e.transactionHash
              ? ` ${targetChainName} transaction hash: ${e.transactionHash}`
              : ""
          }\nStatus: ${
            e.refundStatus == RefundStatus.RefundSent
              ? "Refund Successful"
              : "Refund Failed"
          }`
      )
      .join("\n");
  }

  return stringifiedInfo;
}
