import { useState, useRef } from 'react';
import { StyleSheet, Text, View, Button, ActivityIndicator, Alert } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const cameraRef = useRef(null);

  if (!permission) return <View />;
  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={{ textAlign: 'center', marginBottom: 10 }}>We need camera access to scan boxes</Text>
        <Button onPress={requestPermission} title="Grant Permission" />
      </View>
    );
  }

  const takePictureAndAnalyze = async () => {
    if (!cameraRef.current) return;
    
    setAnalyzing(true);
    try {
      // Captures the image into a local cache URI
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.5 });
      
      const filename = "sensor.jpg";
      const match = photo.uri.match(/\.(\w+)$/);
      const type = match ? `image/${match[1]}` : `image/jpeg`;

      const formData = new FormData();
      formData.append('file', { uri: photo.uri, name: filename, type });

      // CRITICAL: Replace 192.168.X.X with your computer's local Wi-Fi IPv4 Address
      // You cannot use localhost or 127.0.0.1 on a physical phone
      const BACKEND_URL = 'http://192.168.1.101:8000/api/v1/analyze-freshness';

      const response = await fetch(BACKEND_URL, {
        method: 'POST',
        body: formData,
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      const data = await response.json();
      setResult(data);
    } catch (error) {
      Alert.alert("Analysis Failed", "Make sure FastAPI is running on your IPv4 address and your phone is on the same Wi-Fi network.");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <View style={styles.container}>
      {result ? (
        <View style={styles.resultContainer}>
          <Text style={styles.header}>Status: {result.status}</Text>
          <Text>Color: {result.color_detected}</Text>
          <Text>pH State: {result.estimated_ph_state}</Text>
          <Text>Freshness: {result.freshness_percentage}%</Text>
          <Text style={styles.action}>Action: {result.action_required}</Text>
          <View style={{ marginTop: 20 }}>
            <Button title="Scan Another Box" onPress={() => setResult(null)} />
          </View>
        </View>
      ) : (
        <View style={styles.cameraContainer}>
          <CameraView style={styles.camera} facing="back" ref={cameraRef} />
          
          {/* Overlay moved OUTSIDE the CameraView */}
          <View style={styles.overlay}>
            {analyzing ? (
              <ActivityIndicator size="large" color="#ffffff" />
            ) : (
              <Button title="Scan Freshness Tag" onPress={takePictureAndAnalyze} color="#4CAF50" />
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center' },
  cameraContainer: { flex: 1 },
  camera: { flex: 1 },
  overlay: { 
    position: 'absolute', 
    bottom: 50, 
    left: 20, 
    right: 20, 
    backgroundColor: 'transparent' 
  },
  resultContainer: { flex: 1, justifyContent: 'center', padding: 20, backgroundColor: '#f5f5f5' },
  header: { fontSize: 24, fontWeight: 'bold', marginBottom: 10 },
  action: { marginTop: 15, fontWeight: 'bold', color: '#D32F2F' }
});