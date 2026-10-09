package com.attahamamah.spotkick;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Our own Wi-Fi multiplayer plugin (lives in this app, not in npm).
        registerPlugin(LanNetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
