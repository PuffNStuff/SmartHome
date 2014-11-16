"use strict"

try { // Load required Node Modules

  var fs       = require('fs');                           // The file system module
  var cli      = require('cli-color');                    // So we can output colors to a tty
  var os       = require('os');                           // The OS Module

  var APIUtil      = require('./APIUtil.js');             // The SmartHome API Utility Function Module
  var APIConfig    = require('./APIConfig.js');           // The SmartHome API Configuration Module
  var BaseDevice   = require('./BaseDeviceClass.js');     // The SmartHome API Base Device Class
  var Firebase     = require("firebase");                 // The Firebase Module
  var WANIP        = require('external-ip')();            // The external-ip module

  var NetworkDiscover = require('./NetworkDiscover.js');  // The SmartHome NetworkDiscover Module

}
catch(e) {
  // Notify the user that we can't load a module...
 // console.error("Unable to load required module: " + e.message.match(/\'.*\'/g)[0] + ". \nSmartHome API cannot continue.\n\n");
  console.error(e.stack);
  // Kill this process...
  process.exit(1);

} // End try/catch block


// <!------------------------------------------- BEGIN SMART HOME API -------------------------------------------!> //


/**
 * SMART HOME API
 * Communicates with the Firebase Server and Individual Wi-Fi devices.
 */
var SmartHome = function() {

  var console = APIUtil.console;

  // Inform firebase that the API is starting up...
  var APIStatus = new Firebase(APIConfig.general.firebaseRootURI + "/" + APIConfig.general.firebaseAPIStatus);
  APIStatus.update({ last_startup: Date.now(), status: "startup pending", code: 0 });

  // So we can ping the backend from the front-end.
  APIStatus.child("ping").on("value", function (data) {
    if(data.val() == "marco") APIStatus.child("ping").set("polo");
  })

  // What to do on uncaught exceptions....
  process.on("uncaughtException", function (e) {
    console.error("An uncaught exception has occured:\n" + e.toString() + "\n\nThe API cannot continue.");
    APIStatus.update({ code: 1, status: "Error: " + e.message.toString(), reachable: false });
    throw e;
  });

  // Update the last_msg_received field anytime there is a value received from firebase...
  var firebaseRoot = new Firebase(APIConfig.general.firebaseRootURI)
  firebaseRoot.on("value", function () {
    APIStatus.update({ last_msg_received: Date.now() });
  })


  /**
   * Perform back-end shutdown operations...
   * Remove all connected devices, etc.
   *
   */
  var shutdown = function () {

    deviceFirebase.remove();
    console.warn("\n\nSmart Home API Server v" + APIConfig.general.version + " Shutting Down...");
    APIStatus.update({ reachable: false, last_shutdown_status: 0, last_shutdown: Date.now() }, function () {
      process.exit(0);
    });

  } // End shutdown()

  process.on("SIGINT", shutdown);

  // <!------------------------- PRIVATE GLOBAL VARIABLES -------------------------!>

  // So we can reference this from within callbacks:
  var self = this;

  // Holds all the drivers:
  var drivers = {};

  // Holds all the interfaces:
  var interfaces = {};

  // The Firebase Reference:
  var fRef = null;

  // For file loading verification:
  var fileCount = 0;
  var numFiles = 0;
  var fileCountI = 0;
  var numFilesI = 0;

  var DriverIDs = -1;
  var nextDriverID = function () { return '0x' + ((++DriverIDs).toString(16)); }

  var Devices = require("./Devices.js");

  // The firebase location for all devices **connected** to the network...
  var deviceFirebase = new Firebase(APIConfig.general.firebaseRootURI + '/' + APIConfig.general.firebaseAllDevicesPath);

  // All network devices
  var networkDevices = undefined;


  Object.defineProperty(this, "Devices", // The Devices object, so other modules can use it...
    {
      get: function () { return Devices; },
      configurable: false,
      enumerable: true,
    }
  );

  // <!---------------------------- BEGIN PROGRAM FLOW ----------------------------!>

  // #1 ---> Write the restart to the log file.
  fs.writeFile(APIConfig.general.logPath, "\n-------------- SMART HOME API BOOT --------------\n\n", { flag: 'a', encoding: 'utf-8' });
  
  // #2 ---> Clear the console.
  console.clear();

  // #3 ---> Clean up configuration values...
  (function () {

    // Append a '/' to APIConfig.devices.driverDirectory if it doesn't have a trailing slash
    if(APIConfig.devices.driverDirectory.charAt(APIConfig.devices.driverDirectory.length - 1) != '/')
      APIConfig.devices.driverDirectory += '/';

    // Append a '/' to APIConfig.devices.driverInterfaces if it doesn't have a trailing slash
    if(APIConfig.devices.interfaceDirectory.charAt(APIConfig.devices.interfaceDirectory.length - 1) != '/')
      APIConfig.devices.interfaceDirectory += '/';

  })();
  

  // #4 ---> Show msg that Smart Home API Server is starting...
  console.warn("Smart Home API Server v" + APIConfig.general.version + " Booting on '" + os.platform() + "'...");

  // #5 ---> Load the device interfaces
  loadInterfaces();

  // #6 ---> Once the interfaces are loaded, load the device drivers:
  self.on("interfaces loaded", loadDrivers);

  // #6 ---> Setup the devices, based on the network devices connected:
  self.on("drivers loaded", function () {

    // Get the network's WAN IP...
    WANIP(function (err, ip) {

      if (err) {
        console.error("WAN IP Retrieval Failed!");
        return;
      }

      // Update the firebase "api_status" object...
      APIStatus.update({ wan_ip: ip, status: "Got Network WAN IPv4", code: 0, reachable: true });
    });

    scanNetwork.call();

    // Once the network scan is complete load rules and schedules...
    self.once("network scan complete", function () {
      var Schedules = require("./Schedules"); // The SmartHome Schedules Module  
      var Rules     = require("./Rules");     // The SmartHome Rules Module
    });
    
  });

  // Set an interval to continuiously re-scan the network:
  setInterval(scanNetwork, APIConfig.devices.scanInterval); 

  
  // <!----------------------------- END PROGRAM FLOW -----------------------------!>

  /**
   * Scans the network for all connected devices by using nmap and ping commands (works on win and unix)
   */
  var scan;
  function scanNetwork() {

    APIStatus.update({ status: "Scanning Network for Connected Devices", code: 0, reachable: true });

    // Notify the user we are scanning the network...
    console.warn("Scanning network for connected devices. Please wait...");

    // Call the NetworkDiscover module,
    scan = new NetworkDiscover.scan();

    // When the discovery is complete, perform the anon-function:
    scan.on("discovery complete", function (dev) {

      var devString = [];
      for(var i in dev) devString.push('    - ' + dev[i].name);
      
      // Tell the user that the scan is complete, and show a list of the devices:
      console.notice("Network scan complete, " + Object.keys(dev).length + " devices found:\n" + devString.join("\n"));

      // Init all devices
      devicesInit(dev);

      self.emit("network scan complete");

    });
  }


  /**
   * Loads the interfaces (as modules) which mitigates the functions each driver must implement.
   */
  function loadInterfaces () {

    // Tell the user we are loading the interfaces...
    console.notice("Loading Device Interfaces...");

    // Read the interface directory...
    fs.readdir(APIConfig.devices.interfaceDirectory, function (error, files) {

      // Silently print the error to the console.
      if(error) { console.error(error); return; }

      // Set numFilesI to the number of files in the interface directory...
      numFilesI = files.length;

      // Loop through each individual file
      files.forEach(function (f) {

        // Get file information for each file
        fs.stat(APIConfig.devices.interfaceDirectory + f, function (error, stat) {

          // Silently print the error to the console.
          if(error) { console.error(error); return; }

          // Split the filename into an array by the delimiter: '.'
          var fnTokens = f.split('.');
          
          // If the file is a file and not a directory and its extension is ".js" (javascript):
          if(stat.isFile() && fnTokens[fnTokens.length - 1] == "js") {

            var driverInterface = require(process.cwd() + "/" + APIConfig.devices.interfaceDirectory + f);

            (driverInterface.type) ?
              interfaces[driverInterface.type.toLowerCase()] = driverInterface :
              console.error("Interface with filename '" + f + "' doesn't declare a type!\nThis interface will not be loaded.");

            console.notice("Interface for '" + driverInterface.type.toLowerCase() + "' devices loaded!");

          } // End if stat.isFile()... block
          
          // Increment the fileCount
          fileCountI++;

        }); // End fs.stat()

      }); // End files.forEach()

    }); // End fs.readdir()
  
    var intervalSumI = 10;
    var intervalI = setInterval(function () {

      if(intervalSumI > APIConfig.general.deviceLoadTimeout) { // Took too long to load interfaces, something's wrong...
        console.error("Unable to load device interfaces. SmartHome API cannot continue.");
        process.exit(1); // POSIX Failure Code
      }
      else if(fileCount >= numFiles) {
        console.notice("Interface Loading Complete...");
        self.emit("interfaces loaded", interfaces);
        clearInterval(intervalI);
      }

      intervalSumI += 10;

    }, 10); // End interval

  } // End loadInterfaces



  /**
   * Load the device drivers (as modules) which communicate with each individual Wi-Fi device:
   */
  function loadDrivers () {

    // Notify the user we are loading the drivers:
    console.notice("Loading Device Drivers...");

    // Read the files in the driver's directory.
    fs.readdir(APIConfig.devices.driverDirectory, function (error, files) {

      // Silently print the error to the console.
      if(error) { console.error(error); return; }

      // Set numFiles equal to the number of files in the driver directory.
      // We need this to check if all have loaded successfully.
      numFiles = files.length;

      // Loop through each file
      files.forEach(function (f) {

        // Get file information for each file
        fs.stat(APIConfig.devices.driverDirectory + f, function (error, stat) {

          // Silently print the error to the console.
          if(error) { console.error(error); return; }

          // Split the filename into an array by the delimiter: '.'
          var fnTokens = f.split('.');
          
          // If the file is a file and not a directory and its extension is ".js" (javascript):
          if(stat.isFile() && fnTokens[fnTokens.length - 1] == "js") {

            var deviceDriver = undefined;

            try { // Try to load the device driver into memory as a node module:

              deviceDriver = require(process.cwd() + "/" + APIConfig.devices.driverDirectory + f);

              if(!validateDeviceDriver(deviceDriver, f)) {
                
                // If driver validation fails, show a message and goto the next driver, fail "silently."
                console.error("Device Driver '" + f + "' has failed validation.\nThis driver will not load, and supported devices will be unable to use this driver.");

              }
              else { // The driver passed validation.

                // Notify the user and add the driver to the driver's array.
                deviceDriver.driverDetails.driverID = nextDriverID();
                console.notice("Device Driver for device '" + deviceDriver.driverDetails.make + " " + deviceDriver.driverDetails.model + "' (v" + deviceDriver.driverDetails.version + ", id:" + deviceDriver.driverDetails.driverID + ") loaded!");
                drivers[deviceDriver.driverDetails.driverID] = deviceDriver;

              } // End if/else block

            }
            catch(e) { // We couldn't "require" the device driver module...
              throw e;
              console.error("Device Driver '" + f + " failed to compile with message:\n" + e.message + "\nThis driver will not load, and supported devices will be unable to use this driver.");
            
            } // End try/catch block

          } // End if stat.isFile()... block
          
          // Increment the fileCount
          fileCount++;

        }); // End fs.stat()

      }); // End files.forEach()

    }); // End fs.readdir()
  
    // Set an interval to check for device driver loading completion.
    var intervalSum = 10;
    var interval = setInterval(function () {

      if(intervalSum > APIConfig.general.deviceLoadTimeout) { // Took too long to load drivers, something's wrong...
        console.error("Unable to load device drivers. SmartHome API cannot continue.");
        process.exit(1); // POSIX Failure Code
      }
      else if(fileCount >= numFiles) {
        console.notice("Driver Loading Complete...");
        self.emit("drivers loaded", drivers);
        clearInterval(interval);
      }

      intervalSum += 10;

    }, 10); // End interval

  } // End loadDrivers()



  /**
   * Sets up individual devices
   */
   function devicesInit (networkDevices) {

    // Clear all currently connected devices
    deviceFirebase.remove();

    APIStatus.update({ status: "Pairing Devices with Drivers" });

    // Push all devices to the "connected_devices" firebase object...
    for(var n in networkDevices) {
      if(!Devices[networkDevices[n].mac]) {
        deviceFirebase.child(networkDevices[n].mac).set({
          name: networkDevices[n].name,
          address: networkDevices[n].address,
          mac: networkDevices[n].mac,
          supported: false,
          driver: "none"
        }); // End set()
      }
    }

    var supportedDevices = 0;

    for(var i in drivers) { // Loop through all the device drivers that have loaded

      // If the driver implements it's own discvoer method, use it rather than using keywords:
      if(drivers[i].discoverable == true && drivers[i].discover && (drivers[i].discover instanceof Function)) {
        
        // Execute the driver's discover function with the following callback:
        drivers[i].discover(drivers[i], function (discoveredDriver, discovered) {

          if(discovered) { // Find the MAC address for the device at the discovered address:

            var discoveredMAC = undefined;

            // Loop through the networkDevices until we find a device with the same address as this device:
            for(var k in networkDevices) if(discovered.address == networkDevices[k].address) discoveredMAC = networkDevices[k].mac;

            if(discoveredMAC) { // Instantiate the new device
              Devices[discoveredMAC] = new drivers[getDriverID(discoveredDriver.driverDetails.make, discoveredDriver.driverDetails.model, discoveredDriver.driverDetails.version)](discovered.name.toLowerCase().replace(/\s+/ig, '_'), discovered.address, discoveredMAC, discovered.port);
              console.warn("Found Supported " + Devices[discoveredMAC].toString());

              // Add the device to firebase
              deviceFirebase.child(discoveredMAC).set({
                name: discovered.name,
                address: discovered.address,
                mac: discoveredMAC,
                port: discovered.port,
                supported: true,
                driver: {
                  make    : discoveredDriver.driverDetails.make,
                  type    : discoveredDriver.driverDetails.type,
                  model   : discoveredDriver.driverDetails.model,
                  version : discoveredDriver.driverDetails.version,
                }
              }); // End set()
              
              // Emit the "instantiated" event
              Devices[discoveredMAC].emit("instantiated");
              supportedDevices++;
            }
            else if(!Devices[discoveredMAC]) { // Print an error
              console.error("Unable to pair driver (" + discoveredDriver.driverDetails.make + ":" + discoveredDriver.driverDetails.model + ":" + discoveredDriver.driverDetails.version + ") discovered device with correct MAC address for device @ " + discovered.address);
            } 
            else {
              // End if block
              supportedDevices++;
            }

          } // End inner if block
        
        }); // End drivers[i].discover()

      }
      else { // The device driver doesn't support discovery use **archaic** keyword method

        for(var n in networkDevices) { // Loop through all the network devices

          for(var k in drivers[i].driverKeywords) { // Loop through the device keywords

            if(networkDevices[n].name.match(RegExp(drivers[i].driverKeywords[k], 'ig'))) { // If the device's name matche's a keyword:

              // Instantiate the device
              Devices[networkDevices[n].mac] = new drivers[getDriverID(drivers[i].driverDetails.make, drivers[i].driverDetails.model, drivers[i].driverDetails.version)](networkDevices[n].name, networkDevices[n].address, networkDevices[n].mac);
              console.warn("Found Supported " + Devices[networkDevices[n].mac].toString());
              
              // Add the device to firebase
              deviceFirebase.child(networkDevices[n].mac).set({
                name: networkDevices[n].name,
                address: networkDevices[n].address,
                mac: networkDevices[n].mac,
                port: (networkDevices[n].port ? networkDevices[n].port : 0),
                supported: true,
                driver: {
                  make    : drivers[i].driverDetails.make,
                  type    : drivers[i].driverDetails.type,
                  model   : drivers[i].driverDetails.model,
                  version : drivers[i].driverDetails.version,
                }
              }); // End set()
              
              // Emit the "instantiated" event
              Devices[networkDevices[n].mac].emit("instantiated");
              if(Devices[networkDevices[n].mac]) supportedDevices++;

              // We found a driver via keyword, break the keyword search loop
              break;

            }

          } // End for(var k in drivers[i].driverKeywords)

        } // End for(var n in networkDevices)

      } // End if(drivers[i].discoverable && drivers[i].discover && (drivers[i].discover instanceof Function))/else

    } // End if/else block

    var then = Date.now();
    // Check to see that supported devices exits
    var devCheckInterval = setInterval(function () {

      if((Date.now() - scan.lastScan > APIConfig.devices.deviceDiscoverTimeout)) { 

        if(supportedDevices <= 0) { // Warn the user that no supported devices were found:
            console.warn("No supported devices were found!\nNext network discovery scan will occur again in: " + APIConfig.devices.scanInterval + " ms.");
        }

        APIStatus.update({ status: "API Ready", last_startup_status: 0, code: 0 });

        // Clear this interval to stop checking
        clearInterval(devCheckInterval);

      } // End if block

    }, 60); // End timeout

   } // End devicesInit()


  /**
   * Utility function to validate a specific device driver.
   * @param c - The device driver as a node module
   * @param f - The device driver's filename
   */
  function validateDeviceDriver (c, f) {

    if(Object.keys(c).length == 0) { // If the device driver required is empty:
      console.error("Device Driver '" + f + "' is empty!\nDid you forget to export your driver object?");
      return false;
    }

    // Make sure the device implements the 'onFirebaseData' function:
    if(!c.prototype.onFirebaseData && !(c.prototype.onFirebaseData instanceof Function)) {
      console.error("Device Driver '" + f + "' does not implement the 'onFirebaseData' method.");
      return false;
    }


    // Make sure the device defines some widgets
    if(!c.prototype.setWidgets && !(c.prototype.setWidgets instanceof Function)) {
      console.error("Device Driver '" + f + "' does not implement the 'setWidgets' method.");
      return false;
    }

    // Make sure the we implement the device details...
    if(!c.driverDetails) {
      console.error("Device Driver '" + f + "' does not define it's driver details (property 'driverDetails').");
      return false;
    }

    // Make sure the we define the keywords for the driver...
    if(!c.driverKeywords) {
      console.warn("Device Driver '" + f + "' does not define any driver keywords (property 'driverKeywords').\nIt will be unable to be paired to any network deivces.");
    }


    // Make sure the driver implements its type
    var doesImplement = c.prototype.implements(interfaces[c.driverDetails.type.toLowerCase()]);

    if(!interfaces[c.driverDetails.type.toLowerCase()] || doesImplement !== true) {
      console.error("Device Driver '" + f + "' does not fully impletment the '" + c.driverDetails.type.toLowerCase() + "' interface:");
      for(var n in doesImplement) console.error("                          - Missing method '" + doesImplement[n] + "'", true);
      return false;
    }

    return true;

  } // End validateDeviceDriver


  /**
   * Get a driver by it's make, model and version:
   */
  function getDriverID (make, model, version) {

    for(var i in drivers) {
      if(drivers[i].driverDetails.make.toLowerCase()    == make.toLowerCase() &&
         drivers[i].driverDetails.model.toLowerCase()   == model.toLowerCase() && 
         drivers[i].driverDetails.version.toLowerCase() == version.toString().toLowerCase())
          return i;
    }

    return undefined;

  } // End getDriverID()

} // --------------------------> End SmartHome Object Function


// Inherit from the "EventEmitter" so we can emit events:
require('util').inherits(SmartHome, require('events').EventEmitter);
// Export the module:
module.exports = new SmartHome();