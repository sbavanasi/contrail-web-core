/*
 * Copyright (c) 2016 Juniper Networks, Inc. All rights reserved.
 */

var config = process.mainModule.exports.config,
    rest = require('../../common/rest.api'),
    async = require('async'),
    logutils = require('../../utils/log.utils'),
    commonUtils = require('../../utils/common.utils'),
    redisUtils = require('../../utils/redis.utils'),
    os = require('os'),
    _ = require('underscore');

var serviceRespData = {},
    activeServiceRespData = {},
    unChangedActiveSvcRespData = {};

function checkIfActiveServiceRespDataChanged (newServiceRespData, serviceType)
{
    try {
        var newData = commonUtils.getValueByJsonPath(newServiceRespData,
                    serviceType + ';data;' + serviceType, [], false)
            oldData = commonUtils.getValueByJsonPath(unChangedActiveSvcRespData,
                    serviceType +';data;' + serviceType, [], false),
            newDataCnt = newData.length, oldDataCnt = oldData.length, i;
        if (!newDataCnt || !oldDataCnt) {
            return true;
        }
        for (i = 0; i < newDataCnt; i++) {
            if (newData[i]['ip-address'] !=
                oldData[i]['ip-address']) {
                return true;
            }
            if (newData[i]['port'] != oldData[i]['port']) {
                return true;
            }
        }
    } catch(e) {
        return true;
    }
    return false;
}

function storeServiceRespData (service, data)
{
    if ((null == service) || (null == data)) {
        return;
    }
    var serviceType = service['serviceType'];
    if (null == serviceRespData[serviceType]) {
        serviceRespData[serviceType] = {};
    }

    serviceRespData[serviceType]['service'] = service;
    serviceRespData[serviceType]['data'] = data;
}

function getActiveServiceRespDataList ()
{
    var key, i, data, dataLen;
    var activeServiceRespData = commonUtils.cloneObj(serviceRespData);
    for(key in activeServiceRespData) {
        data = activeServiceRespData[key]["data"][key];
        dataLen = data.length;
        for(i = dataLen - 1 ; i > -1; i--) {
            if(data[i].status === "down") {
                data.splice(i, 1);
            }
        }
    }
    return activeServiceRespData;
}

function getActiveRequestedService (serviceType)
{
    var newServiceRespData = getActiveServiceRespDataList();
    if(checkIfActiveServiceRespDataChanged(newServiceRespData, serviceType)) {
        activeServiceRespData[serviceType] = newServiceRespData[serviceType];
    } else {
        activeServiceRespData =
            _.isEmpty(activeServiceRespData) ?
                    unChangedActiveSvcRespData : activeServiceRespData;
    }
    return activeServiceRespData;
}

function storeUnChangedActiveSvcRespData (serviceType, data)
{
    if ((null == serviceType) || (null == data)) {
        return;
    }
    var service = {"serviceType": serviceType};
    if (null == unChangedActiveSvcRespData[serviceType]) {
        unChangedActiveSvcRespData[serviceType] = {};
    }

    var dataSub = data[serviceType], dataLen = dataSub.length;
    for(i = dataLen - 1 ; i > -1; i--) {
        if(dataSub[i].status === "down") {
            dataSub.splice(i, 1);
        }
    }
    unChangedActiveSvcRespData[serviceType]['service'] = service;
    unChangedActiveSvcRespData[serviceType]['data'] = data;
    logutils.logger.debug("Contrail Service Response Updated by process:" +
                          process.pid + " " + JSON.stringify(data));
}

/* Function: getContrailServiceByServiceType
   This function uses load balancing internally
   Always it returns the first server IP/Port combination in the service list and
   pushes that at the end, such that next time when new request comes then this
   server should be requested at last, as we have already sent the request to
   this server.
 */
function getContrailServiceByServiceType (serviceType)
{
    var activeServRespData = getActiveRequestedService(serviceType);
    if (null != activeServRespData[serviceType]) {
        try {
            if(serviceType === global.CONTRAIL_SERVICE_TYPE_DNS_SERVER) {
                return commonUtils.getValueByJsonPath(activeServRespData,
                        serviceType + ';data;' + serviceType + ";0", null);
            } else {
                var service =
                    activeServRespData[serviceType]['data'][serviceType].shift();
                activeServRespData[serviceType]['data'][serviceType].push(service);
                return service;
            }
        } catch(e) {
        }
    }
    return null;
}

function getContrailServiceByApiServerType (apiServerType)
{
    var service     = null;
    var serviceType = null;
    var respObj = [];

    switch (apiServerType) {
    case global.label.OPS_API_SERVER:
    case global.label.OPSERVER:
        serviceType = global.CONTRAIL_SERVICE_TYPE_OP_SERVER;
        break;

    case global.label.VNCONFIG_API_SERVER:
    case global.label.API_SERVER:
        serviceType = global.CONTRAIL_SERVICE_TYPE_API_SERVER;
        break;

    case global.label.DNS_SERVER:
        serviceType = global.CONTRAIL_SERVICE_TYPE_DNS_SERVER;
        break;

    default:
        return null;
    }
    return getContrailServiceByServiceType(serviceType);
}

function getServerTypeByServerName (serverName)
{
    switch (serverName) {
    case global.label.OPS_API_SERVER:
        return global.CONTRAIL_SERVICE_TYPE_OP_SERVER;
    case global.label.OPS_API_SERVER:
    case global.label.VNCONFIG_API_SERVER:
        return global.CONTRAIL_SERVICE_TYPE_API_SERVER;
    case global.label.DNS_SERVER:
        return global.CONTRAIL_SERVICE_TYPE_DNS_SERVER;
    default:
        return null;
    }
}

function resetServicesByParams (params, apiName)
{
    var serviceType = getServerTypeByServerName(apiName);
    if (null == serviceType) {
        return null;
    }
    try {
        var servData = activeServiceRespData[serviceType]['data'][serviceType];
        var servCnt = servData.length;
        if (servCnt <= 1) {
            /* Only one/no server, so no need to do any params update, as no other
             * server available
             */
            return null;
        }
        for (var i = 0; i < servCnt; i++) {
            if ((servData[i]['ip-address'] == params['url']) &&
                (servData[i]['port'] == params['port'])) {
                activeServiceRespData[serviceType]['data'][serviceType].splice(i, 1);
                break;
            }
        }
        params['url'] =
            activeServiceRespData[serviceType]['data'][serviceType][0]['ip-address'];
        params['port'] =
            activeServiceRespData[serviceType]['data'][serviceType][0]['port'];
    } catch(e) {
        logutils.logger.error("In resetServicesByParams(): exception occurred" +
                              " " + e);
        return null;
    }
    return params;
}

function subscribeToContrailService (serviceObj, callback)
{
    var apiServer = serviceObj.apiServer,
        url = serviceObj.url;
    apiServer.api.get(url, function(err, data) {
        if(err){
            callback(null, {err: err, data:
                {serviceType: serviceObj.serviceType, data: data}});
            return;
        }
        callback(null, {err: null, data:
            {serviceType: serviceObj.serviceType, data: data}});
    });
}

function getContrailServices ()
{
    var dataObjArr = [];

    /* opserver */
    processContrailService(global.CONTRAIL_SERVICE_TYPE_OP_SERVER, dataObjArr);

    /* apiserver */
    dataObjArr = [];
    processContrailService(global.CONTRAIL_SERVICE_TYPE_API_SERVER, dataObjArr);

    /* dnsserver */
    dataObjArr = [];
    processContrailService(global.CONTRAIL_SERVICE_TYPE_DNS_SERVER, dataObjArr);
}

function processContrailService (serviceType, dataObjArr)
{
    storeServiceRespData({"serviceType": serviceType},
            formatDataForContrailServices(serviceType,
                    dataObjArr));
    async.map(dataObjArr, subscribeToContrailService, function(err, data) {
        updateContrailServiceData(data);
    });
}

function updateContrailServiceData(statusData)
{
    var serviceType = commonUtils.getValueByJsonPath(statusData,
            '0;data;serviceType', "", false),
        data = commonUtils.getValueByJsonPath(serviceRespData,
                serviceType + ";data;" + serviceType, [], false),
        statusDataLen = statusData.length, i, actData = {},
        actService = {"serviceType": serviceType};
    for(i = 0; i < statusDataLen; i++) {
        if ((null != statusData[i].err) &&
            (('ECONNREFUSED' == statusData[i].err.code) ||
            ('ETIMEOUT' == statusData[i].err.code))) {
            data[i].status = "down";
        } else {
            data[i].status = "up";
        }
    }
    actData[serviceType] = data;
    storeUnChangedActiveSvcRespData(serviceType, actData);
}

function formatDataForContrailServices (serviceType, dataObjArr)
{
    var data = {};
    switch(serviceType) {
        case global.CONTRAIL_SERVICE_TYPE_OP_SERVER:
            data[serviceType] = [];
            formatConfigData(data[serviceType],
                    "analytics", dataObjArr, serviceType);
            break;
        case global.CONTRAIL_SERVICE_TYPE_API_SERVER:
            data[serviceType] = [];
            formatConfigData(data[serviceType],
                    "cnfg", dataObjArr, serviceType);
            break;
        case global.CONTRAIL_SERVICE_TYPE_DNS_SERVER:
            data[serviceType] = [];
            formatConfigData(data[serviceType], "dns", dataObjArr, serviceType);
            break;
    }
    return data;
}

function formatConfigData (data, serviceId, dataObjArr, serviceType)
{
    var serverDetails  = commonUtils.getValueByJsonPath(config, serviceId, {}),
        ipList = commonUtils.getValueByJsonPath(serverDetails, "server_ip", []),
        port = commonUtils.getValueByJsonPath(serverDetails, "server_port", ""),
        statusUrl = commonUtils.getValueByJsonPath(serverDetails,
                "statusURL", ""),
        ipListLen, i;
    ipList = _.isArray(ipList) ? ipList : [ipList];
    ipListLen = ipList.length;
    for(i = 0; i < ipListLen; i++) {
        data.push({
            "@publisher-id" : ipList[i],
            "ip-address": ipList[i],
            "port": port,
            "status": "down"
        });

        dataObjArr.push({
            apiServer: rest.getAPIServer({server: ipList[i], port: port}),
            url: statusUrl,
            serviceType: serviceType
        });
    }
    return {data : data, dataObjArr : dataObjArr};
}

function startWatchContrailServiceRetryList ()
{
    setInterval (function() {
        getContrailServices();
    }, global.CONTRAIL_SERVICE_RETRY_TIME);
}

function subscribeContrailServiceOnDemand ()
{
    getContrailServices();
}

function getContrailServiceRespDataList (req, res, appData)
{
    commonUtils.handleJSONResponse(null, res, getActiveServiceRespDataList());
}

exports.getContrailServices = getContrailServices;
exports.startWatchContrailServiceRetryList = startWatchContrailServiceRetryList;
exports.subscribeContrailServiceOnDemand = subscribeContrailServiceOnDemand;
exports.getContrailServiceByApiServerType = getContrailServiceByApiServerType;
exports.getActiveServiceRespDataList = getActiveServiceRespDataList;
exports.resetServicesByParams = resetServicesByParams;
exports.getContrailServiceRespDataList = getContrailServiceRespDataList;



