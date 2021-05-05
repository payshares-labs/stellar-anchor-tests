import {
  Transaction,
  TransactionBuilder,
  Keypair,
  FeeBumpTransaction,
} from "stellar-sdk";
import fetch from "node-fetch";
import { Request } from "node-fetch";
import { URLSearchParams } from "url";
import { decode } from "jsonwebtoken";
import { validate } from "jsonschema";

import { Result, Failure, NetworkCall } from "../types";
import { makeFailure } from "./failure";
import { jwtSchema } from "../schemas/sep10";

export const getChallengeFailureModes: Record<string, Failure> = {
  NO_TOML: {
    name: "no TOML file",
    text(_args: any): string {
      return "Unable to fetch TOML";
    },
  },
  NO_WEB_AUTH_ENDPOINT: {
    name: "no WEB_AUTH_ENDPOINT",
    text(_args: any): string {
      return "No WEB_AUTH_ENDPOINT in TOML file";
    },
  },
  CONNECTION_ERROR: {
    name: "connection error",
    text(args: any): string {
      return (
        `A connection failure occured when making a request to: ` +
        `\n\n${args.url}\n\n` +
        `Make sure that CORS is enabled.`
      );
    },
  },
  UNEXPECTED_STATUS_CODE: {
    name: "unexpected status code",
    text(_args: any): string {
      return "200 Success is expected for valid requests";
    },
  },
  BAD_CONTENT_TYPE: {
    name: "bad content type",
    text(_args: any): string {
      return "Content-Type headers for responses must be 'application/json'";
    },
  },
  NO_TRANSACTION: {
    name: "missing 'transaction' field",
    text(_args: any): string {
      return (
        "GET /auth response bodies must include a 'transaction' attribute containing a challenge transaction." +
        "See here for more information:\n\n" +
        "https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md#response"
      );
    },
  },
  DESERIALIZATION_FAILED: {
    name: "transaction deserialization failed",
    text(args: any): string {
      return (
        "Unable to decode the 'transaction' value:\n\n. " +
        `${args.transaction}\n\n` +
        `With network passphrase: ${args.networkPassphrase}\n\n` +
        "'transaction' must be a base64-encoded string of the Stellar transaction XDR."
      );
    },
  },
  INVALID_TRANSACTION_TYPE: {
    name: "invalid transaction type",
    text(_args: any): string {
      return "FeeBumpTransactions are not valid challenge transactions";
    },
  },
  NONZERO_SEQUENCE_NUMBER: {
    name: "non-zero sequence number",
    text(_args: any): string {
      return (
        "Challenge transaction must have a sequence number of 0. See the documentation:\n\n" +
        "https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md#response"
      );
    },
  },
};

export const postChallengeFailureModes: Record<string, Failure> = {
  NO_TOKEN: {
    name: "no token",
    text(_args: any): string {
      return "A 'token' attribute must be present in responses to valid POST /auth requests";
    },
  },
  JWT_DECODE_FAILURE: {
    name: "JWT decode failure",
    text(args: any): string {
      return (
        "Unable to decode the JWT.\n\n" +
        `The jsonwebtoken library returned: ${args.error}`
      );
    },
  },
  JWT_NOT_JSON: {
    name: "JWT contents is not JSON",
    text(_args: any): string {
      return "jsonwebtoken was unable to parse the JWT's contents as JSON";
    },
  },
  INVALID_JWT_SCHEMA: {
    name: "invalid JWT content schema",
    text(args: any): string {
      return `${args.errors}`;
    },
  },
  INVALID_JWT_SUB: {
    name: "invalid jwt 'sub' attribute",
    text(_args: any): string {
      return (
        "The 'sub' attribute must be the public key of the account " +
        "authenticating via SEP-10 - the client's public key."
      );
    },
  },
  ...getChallengeFailureModes,
};

export async function getChallenge(
  clientKeypair: Keypair,
  tomlObj: any,
  result: Result,
): Promise<Transaction | void> {
  if (!tomlObj) {
    result.failure = makeFailure(getChallengeFailureModes.NO_TOML);
    return;
  } else if (!tomlObj.WEB_AUTH_ENDPOINT) {
    result.failure = makeFailure(getChallengeFailureModes.NO_WEB_AUTH_ENDPOINT);
    return;
  }
  const getAuthCall: NetworkCall = {
    request: new Request(
      tomlObj.WEB_AUTH_ENDPOINT + `?account=${clientKeypair.publicKey()}`,
    ),
  };
  result.networkCalls.push(getAuthCall);
  try {
    getAuthCall.response = await fetch(getAuthCall.request.clone());
  } catch {
    result.failure = makeFailure(getChallengeFailureModes.CONNECTION_ERROR, {
      url: getAuthCall.request.url,
    });
    return;
  }
  if (getAuthCall.response.status !== 200) {
    result.failure = makeFailure(
      getChallengeFailureModes.UNEXPECTED_STATUS_CODE,
    );
    result.expected = 200;
    result.actual = getAuthCall.response.status;
    return;
  }
  const getAuthContentType = getAuthCall.response.headers.get("Content-Type");
  if (!getAuthContentType || getAuthContentType !== "application/json") {
    result.failure = makeFailure(getChallengeFailureModes.BAD_CONTENT_TYPE);
    result.expected = "application/json";
    if (getAuthContentType) result.actual = getAuthContentType;
    return;
  }
  const responseBody = await getAuthCall.response.clone().json();
  if (!responseBody.transaction) {
    result.failure = makeFailure(getChallengeFailureModes.NO_TRANSACTION);
    return;
  }
  let challenge: Transaction | FeeBumpTransaction;
  try {
    challenge = TransactionBuilder.fromXDR(
      responseBody.transaction,
      tomlObj.NETWORK_PASSPHRASE,
    );
  } catch {
    result.failure = makeFailure(
      getChallengeFailureModes.DESERIALIZATION_FAILED,
      {
        transaction: responseBody.transaction,
        networkPassphrase: tomlObj.NETWORK_PASSPHRASE,
      },
    );
    return;
  }
  if (challenge instanceof FeeBumpTransaction) {
    result.failure = makeFailure(
      getChallengeFailureModes.INVALID_TRANSACTION_TYPE,
    );
    return;
  } else if (challenge.sequence !== "0") {
    result.failure = makeFailure(
      getChallengeFailureModes.NONZERO_SEQUENCE_NUMBER,
    );
    return;
  }
  return challenge;
}

export async function postChallenge(
  clientKeypair: Keypair,
  tomlObj: any,
  result: Result,
  useJson: boolean = false,
): Promise<string | void> {
  const challenge = await getChallenge(clientKeypair, tomlObj, result);
  if (!challenge) return;
  challenge.sign(clientKeypair);
  let request: Request;
  if (useJson) {
    request = new Request(tomlObj.WEB_AUTH_ENDPOINT, {
      method: "POST",
      body: JSON.stringify({ transaction: challenge.toXDR() }),
      headers: { "Content-Type": "application/json" },
    });
  } else {
    request = new Request(tomlObj.WEB_AUTH_ENDPOINT, {
      method: "POST",
      body: new URLSearchParams({ transaction: challenge.toXDR() }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }
  const postAuthCall: NetworkCall = { request: request };
  result.networkCalls.push(postAuthCall);
  try {
    postAuthCall.response = await fetch(postAuthCall.request.clone());
  } catch {
    result.failure = makeFailure(postChallengeFailureModes.CONNECTION_ERROR, {
      url: postAuthCall.request.url,
    });
    return;
  }
  if (postAuthCall.response.status !== 200) {
    result.failure = makeFailure(
      postChallengeFailureModes.UNEXPECTED_STATUS_CODE,
    );
    result.expected = 200;
    result.actual = postAuthCall.response.status;
    return;
  }
  const postAuthResponseContentType = postAuthCall.response.headers.get(
    "Content-Type",
  );
  if (
    !postAuthResponseContentType ||
    postAuthResponseContentType !== "application/json"
  ) {
    result.failure = makeFailure(postChallengeFailureModes.BAD_CONTENT_TYPE);
    result.expected = "application/json";
    if (postAuthResponseContentType)
      result.actual = postAuthResponseContentType;
    return;
  }
  const responseBody = await postAuthCall.response.clone().json();
  if (!responseBody.token) {
    result.failure = makeFailure(postChallengeFailureModes.NO_TOKEN);
    return;
  }
  let jwtContents;
  try {
    jwtContents = decode(responseBody.token);
  } catch (e) {
    result.failure = makeFailure(postChallengeFailureModes.JWT_DECODE_FAILURE, {
      error: e.message,
    });
    return;
  }
  if (!jwtContents || typeof jwtContents !== "object") {
    result.failure = makeFailure(postChallengeFailureModes.JWT_NOT_JSON);
    return;
  }
  const validatorResult = validate(jwtContents, jwtSchema);
  if (validatorResult.errors.length !== 0) {
    result.failure = makeFailure(postChallengeFailureModes.INVALID_JWT_SCHEMA, {
      errors: validatorResult.errors.join("\n"),
    });
    return;
  }
  try {
    Keypair.fromPublicKey(jwtContents.sub);
  } catch {
    result.failure = makeFailure(postChallengeFailureModes.INVALID_JWT_SUB);
    return;
  }
  return responseBody.token;
}