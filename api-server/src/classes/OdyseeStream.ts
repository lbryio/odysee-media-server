// Created by xander on 3/19/2021
'use strict';

import logger from './Logger';
const log = logger('AUTH');

import { serverData } from './ServerData';

import * as chalk from 'chalk';
import * as rp from 'request-promise';

import * as admin from 'firebase-admin';

const hlsStream: string  = `hls`;
const transcodeStream: string = `transcode`;
const thumbnail: string  = `preview`;

export default class OdyseeStream {
  private readonly hostServer: string;
  private readonly cdnServer: string;

  constructor( config ) {
    this.hostServer = config.hostServer;
    this.cdnServer  = config.cdnServer;
  }

  /**
   * Set streamer live status and transcode status
   * @param {string} claimId - Streamer's username
   * @param {boolean} isLive - LIVE / OFFLINE status
   * @return {Promise<void>}
   */
  async setLiveStatus ( claimId: string, isLive: boolean ): Promise<void> {
    // Reference to odysee stream document
    const streamRef = admin
      .firestore()
      .collection( 'odysee-streams' )
      .doc( claimId.toLowerCase() );

    const streamUrl = `https://${this.cdnServer}/${hlsStream}/${claimId}/index.m3u8`;
    const thumbUrl  = `https://${this.cdnServer}/${thumbnail}/${claimId}.jpg`;

    await streamRef.set({
      claimId: claimId,
      live: isLive,
      url: streamUrl,
      type: 'application/x-mpegurl',
      thumbnail: thumbUrl,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    if ( isLive ) {
      serverData.addStreamer( claimId );
    } else {
      serverData.removeStreamer( claimId );
    }

    log.info( `${chalk.cyanBright(claimId)} is now ${ isLive ? chalk.greenBright.bold('LIVE') : chalk.redBright.bold('OFFLINE') }` );
  };

  /**
   * Set transcode status and livestream endpoint
   * @param {string} claimId - Streamer's claimId
   * @param {boolean} transcoded - Transcode status
   * @param {string?} location - Transcode location
   * @return {Promise<void>}
   */
  async setTranscodeStatus ( claimId: string, transcoded: boolean, location?: string ): Promise<void> {
    const streamRef = admin.firestore()
      .collection( 'odysee-streams' )
      .doc( claimId.toLowerCase() );

    const doc = await streamRef.get();

    if ( !doc.exists ) {
      log.info( `${chalk.bgRedBright.black('ERROR:')} ${claimId} is not a valid streamer` );
      return;
    }

    let url: string;
    if ( transcoded ) {
      // url = `https://${this.cdnServer}/${transcodeStream}/${username}.m3u8`;
      url = `https://${this.cdnServer}/${location}/${claimId}.m3u8`;
    } else {
      url = `https://${this.cdnServer}/${hlsStream}/${claimId}/index.m3u8`;
    }

    await streamRef.update({
      url: url,
    });

    log.info( `${chalk.cyanBright(claimId)}'s transcoder has ${ transcoded ? chalk.greenBright.bold('started') : chalk.redBright.bold('stopped') }.` );
  };

  /**
   * Check streamer's archive setting
   * @param {string} claimId - Streamer's claimId
   * @return {Promise<boolean>}
   */
  async checkArchive( claimId: string ): Promise<boolean> {
    const streamRef = admin
      .firestore()
      .collection( 'odysee-streams' )
      .doc( claimId.toLowerCase() );
    const doc = await streamRef.get();

    if ( !doc.exists ) {
      log.info( `${chalk.bgRedBright.black('ERROR:')} ${claimId} is not a valid streamer` );
      return;
    }

    const data = doc.data();
    return !!data.archive;
  };

  /**
   * Passes archive information to API server
   * @param {string} claimId
   * @param {string} location
   * @param {number} duration
   * @param {Array<string>} thumbnails
   * @return {Promise<void>}
   */
  async saveArchive ( claimId: string, location: string, duration: number, thumbnails: string[] ): Promise<void> {
    const options = {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      form: {
        server: this.hostServer,
        username: claimId,
        location: location,
        duration: duration,
        thumbnails: thumbnails,
      },
    };

    try {
      const response = await rp.post( 'https://api.bitwave.tv/v1/archives',  options );
      log.info( response );
    } catch ( error ) {
      log.info( error );
    }
  };

  /**
   * Verifies an odysee channel signed streamkey via signature
   * @param {string} claimId
   * @param {string} hexData
   * @param {string} signature
   * @param {string} signatureTs
   * @return {Promise<boolean>} valid
   */
  async verifySignature ( claimId: string, hexData: string, signature: string, signatureTs: string ): Promise<boolean> {
    // Odysee JSON RPC Method
    const rpcMethod = 'verify.Signature'

    // Odysee JSON RPC Payload
    const body = {
      jsonrpc: "2.0",
      method: rpcMethod,
      id: 0,
      params: {
        'channel_id': claimId,
        'signature': signature,
        'signing_ts': signatureTs,
        'data_hex': hexData,
      },
    };

    // Build Post Request Options
    const options = {
      headers: {
        'content-type': 'application/json',
      },
      json: true,
      body: body,
    };

    // Submit API request to Odysee API
    let response = undefined;
    try {
      response = await rp.post( 'https://comments.lbry.com/api/v2?m=verify.Signature', options );
      // Log Odysee API request
      log.info( `SENT: ${JSON.stringify( body )}`,  )
      log.info( `RESPONSE: ${JSON.stringify( response )}` );
    } catch ( error ) {
      log.info( 'Error during Odysee API call to validate channel sign!' );
      log.error( error );
      return  false;
    }

    // Process Odysee API Response
    if ( !response ) {
      log.info( chalk.redBright( `Odysee API response was empty (Odysee API Error)` ) );
      return false;
    }
    // Verified streamkey signature
    if ( response.result && response.result?.is_valid ) {
      log.info( chalk.greenBright( `Odysee signature verified!` ) );
      return true;
    }
    // Odysee API returned an error
    if ( response && response.error ) {
      log.info( chalk.redBright( `Invalid Odysee Signature: ${response.error?.message}` ) );
      return false;
    }
    // Malformed response
    log.info( chalk.redBright( `Odysee signature failed verification! (invalid Odysee API response)` ) );
    return false;
  }
}